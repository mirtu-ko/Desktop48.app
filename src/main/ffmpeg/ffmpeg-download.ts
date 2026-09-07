import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { Buffer } from 'node:buffer'
import type { FfmpegDownloadProgress } from '../../preload/api-types'
import fs from 'node:fs'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import { app, net } from 'electron'
import { handleTraced } from '../ipc/trace'
import { log, warn } from '../logger'

/**
 * ffmpeg 在线下载：按当前平台从 ffmpeg-static 的 npmmirror 镜像拉取预编译二进制，
 * 解压写入应用数据目录（userData/ffmpeg），首次初始化时一键完成环境配置。
 *
 * - 选 npmmirror：与 electron-builder.yml 的 electronDownload.mirror 同源，国内可直连；
 *   ffmpeg-static 不含 ffplay，而应用只使用 ffmpeg（stream.ts 拉流 / ffmpeg-process.ts 任务），
 *   checkFfmpegBinaries 已相应放宽为只检查 ffmpeg
 * - 产物是 gzip 单文件（.gz），用 Node 内置 zlib 解压，不依赖系统解压工具
 * - 进度经 ffmpegDownloadProgress 通道回推发起方（webContents 销毁后静默丢弃）
 */

/** ffmpeg-static 镜像上固定的构建版本（升级时手动更换并回归验证拉流/录制） */
const FFMPEG_STATIC_VERSION = 'b6.0'

export interface FfmpegDownloadSource {
  url: string
  /** 解压落盘后的可执行文件名（win32 为 ffmpeg.exe） */
  filename: string
}

/** 按平台与架构选择 ffmpeg-static 预编译二进制（纯函数，可单测） */
export function pickFfmpegSource(platform: string, arch: string): FfmpegDownloadSource {
  const base = `https://registry.npmmirror.com/-/binary/ffmpeg-static/${FFMPEG_STATIC_VERSION}`
  let name: string
  if (platform === 'darwin')
    name = arch === 'arm64' ? 'ffmpeg-darwin-arm64' : 'ffmpeg-darwin-x64'
  else if (platform === 'win32')
    name = 'ffmpeg-win32-x64'
  else if (platform === 'linux')
    name = arch === 'arm64' ? 'ffmpeg-linux-arm64' : 'ffmpeg-linux-x64'
  else
    throw new Error(`暂不支持的平台: ${platform}`)

  return {
    url: `${base}/${name}.gz`,
    filename: platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  }
}

/** 下载进度回推通道（渲染端经 preload 的 onFfmpegDownloadProgress 订阅） */
const FFMPEG_DOWNLOAD_PROGRESS_CHANNEL = 'ffmpegDownloadProgress'

/**
 * 下载落盘目录：userData/ffmpeg。安装目录受代码签名/权限约束不能作为写入目标，
 * 且 userData 已在 openPath 的允许根列表内（register-system-ipc.ts）
 */
function ffmpegTargetDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg')
}

/** 60s 无新数据视为网络卡死；慢网络整体耗时可能很长，不能按总时长设超时 */
const DOWNLOAD_STALL_TIMEOUT_MS = 60 * 1000

/** 进度上报节流间隔：ffmpeg 二进制几十 MB，按 512KB 粒度上报足以平滑展示 */
const PROGRESS_REPORT_STEP = 512 * 1024

/**
 * 下载 gzip 文件并边下载边解压写入 dest；失败时清理半成品。
 * 使用 Electron net 模块（自动跟随重定向）+ zlib 解压流。
 */
function downloadBinary(url: string, dest: string, onProgress: (p: FfmpegDownloadProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request(url)
    // .gz 文件本身已是压缩格式，显式声明不再压缩，避免 CDN 传输压缩造成双重解压
    request.setHeader('accept-encoding', 'identity')

    let settled = false
    let received = 0
    let total = 0
    let lastReported = 0
    let stallTimer: NodeJS.Timeout | undefined
    const file = fs.createWriteStream(dest)
    const gunzip = createGunzip()
    gunzip.pipe(file)

    const settle = (err?: Error) => {
      if (settled)
        return
      settled = true
      if (stallTimer)
        clearTimeout(stallTimer)
      if (err) {
        request.abort()
        gunzip.destroy()
        file.destroy()
        // 清理半成品：落盘的是 .download 临时名，正常流程不会伪装成已下载，这里兜底不留垃圾
        fs.promises.unlink(dest).catch(() => {})
        reject(err)
        return
      }
      // 成功路径等全部解压数据落盘后由 file 的 finish 回调 resolve
      gunzip.end()
    }

    const resetStallTimer = () => {
      if (stallTimer)
        clearTimeout(stallTimer)
      stallTimer = setTimeout(
        () => settle(new Error(`下载超时：${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s 内无数据`)),
        DOWNLOAD_STALL_TIMEOUT_MS,
      )
    }

    file.on('error', err => settle(err))
    gunzip.on('error', err => settle(new Error(`解压失败（文件可能不完整）: ${err.message}`)))
    file.on('finish', () => {
      onProgress({ received, total })
      resolve()
    })

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        settle(new Error(`下载失败 HTTP ${response.statusCode}: ${url}`))
        return
      }
      const contentLength = Number(response.headers['content-length'])
      total = Number.isFinite(contentLength) ? contentLength : 0

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        gunzip.write(chunk)
        if (received - lastReported >= PROGRESS_REPORT_STEP) {
          lastReported = received
          onProgress({ received, total })
        }
        resetStallTimer()
      })
      response.on('end', () => {
        if (total > 0 && received < total) {
          settle(new Error(`下载不完整（${received}/${total} 字节）`))
          return
        }
        settle()
      })
      response.on('aborted', () => settle(new Error('下载被中断')))
      response.on('error', err => settle(err))
      resetStallTimer()
    })
    request.on('error', err => settle(err))
    request.end()
  })
}

/** 防重入：多窗口/连点共享同一次下载，第二个调用方等到同一结果 */
let inFlight: Promise<string> | null = null

async function runDownload(sender: WebContents): Promise<string> {
  const source = pickFfmpegSource(process.platform, process.arch)
  const dir = ffmpegTargetDir()
  const targetPath = path.join(dir, source.filename)
  // 已存在则直接复用（重复发起不重复下载）；半成品写 .download 临时名，不会误判
  if (fs.existsSync(targetPath)) {
    log('[ffmpeg-download]ffmpeg 已存在，跳过下载:', targetPath)
    return dir
  }
  await fs.promises.mkdir(dir, { recursive: true })

  const reportProgress = (p: FfmpegDownloadProgress) => {
    if (!sender.isDestroyed())
      sender.send(FFMPEG_DOWNLOAD_PROGRESS_CHANNEL, p)
  }
  const tempPath = `${targetPath}.download`
  try {
    log('[ffmpeg-download]开始下载 ffmpeg:', source.url)
    await downloadBinary(source.url, tempPath, reportProgress)
    await fs.promises.rename(tempPath, targetPath)
  }
  catch (err) {
    warn('[ffmpeg-download]ffmpeg 下载失败:', err)
    // downloadBinary 已清理下载失败场景，这里兜底改名失败等残留
    await fs.promises.unlink(tempPath).catch(() => {})
    throw err
  }
  if (process.platform !== 'win32')
    await fs.promises.chmod(targetPath, 0o755)

  log('[ffmpeg-download]ffmpeg 下载完成:', targetPath)
  return dir
}

/**
 * ffmpeg 在线下载通道（对端：preload/index.ts 的 downloadFfmpeg / onFfmpegDownloadProgress）。
 * 返回 ffmpeg 所在目录，渲染层据此 checkFfmpegBinaries 并写入 ffmpegDirectory 配置。
 */
export function registerFfmpegDownloadIPC(): void {
  handleTraced('downloadFfmpeg', async (event: IpcMainInvokeEvent): Promise<string> => {
    if (inFlight)
      return inFlight
    inFlight = runDownload(event.sender).finally(() => {
      inFlight = null
    })
    return inFlight
  })
}
