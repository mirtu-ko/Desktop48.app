import type { FeedbackInput } from '@common/feedback'
import type { NetRequestOptions, NetResponse } from '@preload/ipc-contract'
/**
 * 系统服务类 IPC 通道注册：路径/对话框/网络请求/ffmpeg 二进制检查。
 *
 * 这些通道的共同点是「无领域状态」——每次调用独立完成，不依赖模块级可变状态，
 * 因此可以直接内联实现而不必拆出业务模块。有状态的领域（数据库/直播流/任务）
 * 各自拥有独立的 register-*-ipc.ts 与业务模块。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { IpcMainInvokeEvent } from 'electron'
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SITE_USER_AGENT } from '@common/android-device'
import { app, clipboard, ClipboardItem, dialog, net, shell } from 'electron'
import { isAllowedUrl } from '../allowed-hosts'
import { isPathInAllowedRoots } from '../allowed-path'
import { Database } from '../database'
import { collectFeedbackMeta, isFeedbackEndpointReady, submitFeedback } from '../feedback'
import { inspectFfmpegDir } from '../ffmpeg/ffmpeg-process'
import { decodePngDataUrl, ensurePngExtension, safePngFileName } from '../image-file'
import { log } from '../logger'
import { diagnoseTargets } from '../net-diagnose'
import { parseRetryAfterMs, penalizeHost, withNetSlot } from '../net-rate-limit'
import { guardRedirects } from '../net-redirect-guard'
import { mergeAppIdentity, needsAppIdentity } from '../net-request-headers'
import { pocketAppHeaders } from '../pocket48/pocket-auth'
import { handleTraced } from './trace'

// 网络请求 - 域名白名单校验
const NET_REQUEST_TIMEOUT = 20 * 1000
const NET_REQUEST_MAX_BYTES = 32 * 1024 * 1024

/** 分享图的远程头像：上限 8MB / 15 秒，避免 CDN 异常时把主进程拖住 */
const IMAGE_FETCH_TIMEOUT = 15 * 1000
const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 取图片二进制。不能复用 performNetRequest：它把响应体按 UTF-8 解码成字符串，
 * 会把 JPEG/PNG 的字节破坏掉。这里逐块收 Buffer，整体拼好再交给调用方转 base64。
 */
function fetchBinaryImage(url: string): Promise<{ data: Buffer, mime: string }> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET' })
    // 静态 CDN 沿用站点身份（与 renderer/services/request.ts 同源）；不带 UA 时
    // net.request 会报 Electron 默认标识，部分图片 CDN 直接拒绝，头像会降级成姓名首字
    request.setHeader('User-Agent', SITE_USER_AGENT)
    request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8')
    let settled = false
    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      request.abort()
      reject(new Error(`图片请求超时（${IMAGE_FETCH_TIMEOUT}ms）: ${url}`))
    }, IMAGE_FETCH_TIMEOUT)
    const fail = (err: Error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
    const succeed = (value: { data: Buffer, mime: string }) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    guardRedirects(request, fail)
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        request.abort()
        fail(new Error(`图片请求失败（${response.statusCode}）: ${url}`))
        return
      }
      const header = response.headers['content-type']
      const mime = String((Array.isArray(header) ? header[0] : header) || '').split(';')[0].trim()
      if (!mime.startsWith('image/')) {
        request.abort()
        fail(new Error(`响应不是图片: ${url}`))
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > IMAGE_MAX_BYTES) {
          request.abort()
          fail(new Error(`图片超过上限（${IMAGE_MAX_BYTES} 字节）: ${url}`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => succeed({ data: Buffer.concat(chunks), mime }))
      response.on('aborted', () => fail(new Error(`图片响应被中断: ${url}`)))
      response.on('error', fail)
    })
    request.on('abort', () => fail(new Error(`图片请求被中断: ${url}`)))
    request.on('error', fail)
    request.end()
  })
}

/**
 * 请求头收口：打口袋体系**业务接口**（pocketapi / h5）的请求改报 App 身份
 * （UA / appInfo / pa），纯静态资源与媒体 CDN 沿用渲染层给的站点档请求头。
 * 域名清单与判定理由见 `net-request-headers.ts`。
 *
 * 身份头生成失败（wasm / 凭证异常）不阻断请求：退回调用方的请求头照常发出，
 * 让服务端的真实应答暴露问题，而不是在本地变形成一个与网络无关的错误。
 */
async function resolveNetRequestHeaders(
  url: string,
  headers?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (!needsAppIdentity(url))
    return headers
  try {
    return mergeAppIdentity(headers, await pocketAppHeaders())
  }
  catch (error) {
    log('[netRequest] App 身份头生成失败，本次沿用调用方请求头', error)
    return headers
  }
}

/**
 * 单次请求（不含出口限流）：非 2xx 也如实返回状态码与正文。
 *
 * 在这里抛错会让状态码丢失——跨 IPC 的 reject 只保留 message，渲染层无法区分
 * 「429 该停」与「502 该重试」，只能一律当网络故障重试，恰好在限流窗口里加剧压力。
 */
function performNetRequest(
  url: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
): Promise<NetResponse> {
  return new Promise<NetResponse>((resolve, reject) => {
    // 逐字段构造而非整对象透传：net.request 会接受 ClientRequest 的全部选项，
    // 整对象透传等于让渲染层塞入 session / credentials 等我们并未打算开放的字段
    const request = net.request({ url, method })
    if (headers) {
      for (const key in headers)
        request.setHeader(key, headers[key])
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled)
        return
      settled = true
      request.abort()
      reject(new Error(`请求超时（${NET_REQUEST_TIMEOUT}ms）: ${url}`))
    }, NET_REQUEST_TIMEOUT)

    const fail = (err: Error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
    const succeed = (response: NetResponse) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }

    guardRedirects(request, fail)
    request.on('response', (response) => {
      // 必须先收齐 Buffer 再整体解码：逐块 toString 会把跨块的 UTF-8 多字节字符切成乱码
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > NET_REQUEST_MAX_BYTES) {
          request.abort()
          fail(new Error(`响应体超过上限（${NET_REQUEST_MAX_BYTES} 字节）: ${url}`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        // 只把首值拍平：Electron 给的是 string[]，渲染层只需要能读到 retry-after 这类单值头
        const responseHeaders: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          const first = Array.isArray(value) ? value[0] : value
          if (first !== undefined)
            responseHeaders[key.toLowerCase()] = String(first)
        }
        succeed({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: responseHeaders,
        })
      })
      response.on('aborted', () => fail(new Error(`响应被中断: ${url}`)))
      response.on('error', (err: Error) => fail(err))
    })
    request.on('abort', () => fail(new Error(`请求被中断: ${url}`)))
    request.on('error', fail)
    if (body)
      request.write(body)
    request.end()
  })
}

export function registerSystemIPC(): void {
  handleTraced('openPath', async (_event: IpcMainInvokeEvent, filePath: string) => {
    // 校验路径：允许系统标准用户目录 + 用户配置的下载目录/ffmpeg目录（判定见 allowed-path.ts）
    const allowedRoots = [
      app.getPath('desktop'),
      app.getPath('downloads'),
      app.getPath('documents'),
      app.getPath('videos'),
      app.getPath('pictures'),
      app.getPath('music'),
      app.getPath('userData'),
    ]
    for (const key of ['downloadDirectory', 'ffmpegDirectory'] as const) {
      const dir = Database.instance().getConfig(key)
      if (dir)
        allowedRoots.push(dir)
    }
    const resolved = path.resolve(filePath)
    if (!isPathInAllowedRoots(resolved, allowedRoots)) {
      throw new Error(`路径不在允许范围内: ${filePath}`)
    }
    // openPath 以返回值（而非 reject）报告失败，必须 await 并检查，否则错误被静默丢弃
    const failure = await shell.openPath(resolved)
    if (failure)
      throw new Error(failure)
  })

  handleTraced('selectDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled)
      return null
    return result.filePaths[0]
  })

  handleTraced('pathJoin', (_event: IpcMainInvokeEvent, ...paths: string[]) => path.join(...paths))

  // 生日贺卡分享图：跨域 <img> 画进 canvas 会污染画布，头像改由主进程取成 data URL
  handleTraced('imageDataUrl', async (_event: IpcMainInvokeEvent, url: string) => {
    if (!url || !isAllowedUrl(url))
      throw new Error(`请求被拒绝：域名不在白名单中 (${url})`)
    // 与 netRequest 共用出口闸门：图片通道不该成为绕过限流的第二条路
    return withNetSlot(url, async () => {
      const { data, mime } = await fetchBinaryImage(url)
      return `data:${mime};base64,${data.toString('base64')}`
    })
  })

  handleTraced('copyImageToClipboard', async (_event: IpcMainInvokeEvent, dataUrl: string) => {
    const buffer = decodePngDataUrl(dataUrl)
    // Electron 44 起 clipboard 换成 W3C 风格：write() + ClipboardItem，旧的 writeImage 已移除
    const blob = new Blob([new Uint8Array(buffer)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })

  handleTraced('saveImageFile', async (_event: IpcMainInvokeEvent, dataUrl: string, suggestedName: string) => {
    const buffer = decodePngDataUrl(dataUrl)
    const safeName = safePngFileName(suggestedName)
    const options = {
      title: '保存生日贺卡',
      defaultPath: path.join(app.getPath('pictures'), safeName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    }
    // ⚠️ 不传父窗口：主窗口是 frameless，模态原生对话框会在对话框期间让渲染层
    // 停止合成、整窗刷白（用户报「点保存后白屏」）。与 selectDirectory 一致用无父窗口对话框。
    const result = await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath)
      return null
    const filePath = ensurePngExtension(result.filePath)
    await writeFile(filePath, buffer)
    return filePath
  })

  handleTraced('netRequest', async (_event: IpcMainInvokeEvent, options: NetRequestOptions) => {
    const { url, method, headers, body } = options
    if (!url || !isAllowedUrl(url)) {
      throw new Error(`请求被拒绝：域名不在白名单中 (${url})`)
    }
    const requestHeaders = await resolveNetRequestHeaders(url, headers)
    // 排队等待不计入请求超时：闸门放在发请求之前，超时由 performNetRequest 自己判
    return withNetSlot(url, async (host) => {
      const response = await performNetRequest(url, method || 'GET', requestHeaders, body)
      // 服务端明说「多久之后再来」时让整域冷却，别让轮询接着撞
      if (response.status === 429)
        penalizeHost(host, parseRetryAfterMs(response.headers['retry-after']))
      return response
    })
  })

  // ffmpeg 环境：不传 dir 时校验当前生效配置，传 dir 时校验指定目录
  // （初始化页/设置页在「选择目录」「一键下载」之后的即时校验）。
  // 判定口径统一在 inspectFfmpegDir，此处只负责取配置。
  handleTraced('getFfmpegStatus', (_event: IpcMainInvokeEvent, dir?: string) => inspectFfmpegDir(dir ?? Database.instance().getConfig('ffmpegDirectory')))

  // 网络诊断：对核心服务域名逐一轻量探测（设置页「网络诊断」），目标清单在 net-diagnose.ts
  handleTraced('netDiagnose', async () => diagnoseTargets())

  // 问题反馈：环境摘要由主进程采集，上报地址不经过渲染层（见 feedback.ts 的边界说明）
  handleTraced('feedbackMeta', () => ({
    meta: collectFeedbackMeta(),
    endpointReady: isFeedbackEndpointReady(),
  }))
  handleTraced('submitFeedback', (_event: IpcMainInvokeEvent, input: FeedbackInput) => submitFeedback(input))
}
