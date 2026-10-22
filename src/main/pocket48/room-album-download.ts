import type { RoomAlbumDownloadProgress, RoomAlbumDownloadResult, RoomAlbumDownloadSource } from '@preload/ipc-contract'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { buildAlbumFileName, isSmallImage } from '@common/image-download'
import { app, dialog, nativeImage, net } from 'electron'
import { isAllowedUrl } from '../allowed-hosts'
import { sendIpc } from '../ipc/send'
import { handleTraced } from '../ipc/trace'
import { log, warn } from '../logger'

/** 单张图片上限与请求超时：防止异常响应无限占内存 / 卡住整批任务 */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30 * 1000
const MAX_IMAGES = 1000

interface FetchedImage {
  data: Buffer
  contentType: string
}

async function fetchImage(url: string): Promise<FetchedImage> {
  const response = await net.fetch(url, {
    headers: { accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`)

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_IMAGE_BYTES)
    throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`)

  const contentType = response.headers.get('content-type') || ''
  if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('html'))
    throw new Error(`响应不是图片: ${contentType}`)

  const data = Buffer.from(await response.arrayBuffer())
  if (!data.length)
    throw new Error('图片响应为空')
  if (data.length > MAX_IMAGE_BYTES)
    throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`)
  return { data, contentType }
}

/** 主进程用 Electron 自带解码器读取图片尺寸；格式不受支持时按未知处理，不误过滤 */
function imageSize(data: Buffer): { width: number, height: number } {
  try {
    return nativeImage.createFromBuffer(data).getSize()
  }
  catch {
    return { width: 0, height: 0 }
  }
}

/** 以 wx 模式写入并自动避让重名；返回最终文件路径 */
async function writeUniqueFile(directory: string, preferredName: string, data: Buffer): Promise<string> {
  const parsed = path.parse(preferredName)
  for (let index = 0; index < 10_000; index += 1) {
    const name = index === 0 ? preferredName : `${parsed.name}-${index}${parsed.ext}`
    const target = path.join(directory, name)
    try {
      await fs.promises.writeFile(target, data, { flag: 'wx' })
      return target
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
    }
  }
  throw new Error(`同名文件过多: ${preferredName}`)
}

function emitProgress(sender: WebContents, progress: RoomAlbumDownloadProgress): void {
  sendIpc(sender, 'roomAlbumDownloadProgress', progress)
}

async function runDownload(
  sender: WebContents,
  sources: RoomAlbumDownloadSource[],
  filterSmall: boolean,
): Promise<RoomAlbumDownloadResult> {
  const picked = await dialog.showOpenDialog({
    title: '选择相册图片保存目录',
    buttonLabel: '保存到这里',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (picked.canceled || !picked.filePaths[0]) {
    return { canceled: true, directory: '', downloaded: 0, skipped: 0, failed: 0 }
  }

  const directory = picked.filePaths[0]
  const selected = sources.slice(0, MAX_IMAGES)
  const result: RoomAlbumDownloadResult = {
    canceled: false,
    directory,
    downloaded: 0,
    skipped: 0,
    failed: Math.max(0, sources.length - selected.length),
  }
  let processed = 0

  for (const [index, source] of selected.entries()) {
    try {
      if (!source || typeof source.url !== 'string' || !isAllowedUrl(source.url)) {
        result.failed += 1
        warn('[room-album-download] 跳过非白名单图片:', source?.url)
      }
      else if (filterSmall && isSmallImage(source.width, source.height)) {
        result.skipped += 1
      }
      else {
        const image = await fetchImage(source.url)
        const size = source.width && source.height
          ? { width: source.width, height: source.height }
          : imageSize(image.data)
        if (filterSmall && isSmallImage(size.width, size.height)) {
          result.skipped += 1
        }
        else {
          const filename = buildAlbumFileName({
            timestamp: source.msgTime,
            nickname: source.nickname,
            width: size.width,
            height: size.height,
            sequence: index + 1,
            url: source.url,
            contentType: image.contentType,
          })
          await writeUniqueFile(directory, filename, image.data)
          result.downloaded += 1
        }
      }
    }
    catch (error) {
      result.failed += 1
      warn('[room-album-download] 图片下载失败:', source?.url, error)
    }
    processed += 1
    emitProgress(sender, {
      processed,
      total: sources.length,
      downloaded: result.downloaded,
      skipped: result.skipped,
      failed: result.failed,
    })
  }

  log(`[room-album-download] 完成：下载 ${result.downloaded}，过滤 ${result.skipped}，失败 ${result.failed}`)
  return result
}

/**
 * 房间相册批量下载：目录选择只在主进程弹一次，随后逐张请求并写盘。
 * 不经过 Chromium 的 `<a download>`：系统「另存为」弹窗不会为每张图重复出现。
 */
export function registerRoomAlbumDownloadIPC(): void {
  handleTraced('roomAlbumDownload', (
    event: IpcMainInvokeEvent,
    sources: RoomAlbumDownloadSource[],
    filterSmall: boolean,
  ) => runDownload(event.sender, sources, filterSmall))
}
