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
import path from 'node:path'
import { app, dialog, net, shell } from 'electron'
import { isAllowedUrl } from '../allowed-hosts'
import { isPathInAllowedRoots } from '../allowed-path'
import { Database } from '../database'
import { inspectFfmpegDir } from '../ffmpeg/ffmpeg-process'
import { log } from '../logger'
import { diagnoseTargets } from '../net-diagnose'
import { acquireNetSlot, parseRetryAfterMs, penalizeHost } from '../net-rate-limit'
import { mergeAppIdentity, needsAppIdentity } from '../net-request-headers'
import { pocketAppHeaders } from '../pocket48/pocket-auth'
import { handleTraced } from './trace'

// 网络请求 - 域名白名单校验
const NET_REQUEST_TIMEOUT = 20 * 1000
const NET_REQUEST_MAX_BYTES = 32 * 1024 * 1024

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

  handleTraced('netRequest', async (_event: IpcMainInvokeEvent, options: NetRequestOptions) => {
    const { url, method, headers, body } = options
    if (!url || !isAllowedUrl(url)) {
      throw new Error(`请求被拒绝：域名不在白名单中 (${url})`)
    }
    const requestHeaders = await resolveNetRequestHeaders(url, headers)
    // 白名单校验已保证 URL 可解析
    const host = new URL(url).hostname
    // 出口闸门放在发请求之前：排队等待不计入请求超时，超时由 acquire 自己判
    const release = await acquireNetSlot(host)
    try {
      const response = await performNetRequest(url, method || 'GET', requestHeaders, body)
      // 服务端明说「多久之后再来」时让整域冷却，别让轮询接着撞
      if (response.status === 429)
        penalizeHost(host, parseRetryAfterMs(response.headers['retry-after']))
      return response
    }
    finally {
      release()
    }
  })

  // ffmpeg 环境：不传 dir 时校验当前生效配置，传 dir 时校验指定目录
  // （初始化页/设置页在「选择目录」「一键下载」之后的即时校验）。
  // 判定口径统一在 inspectFfmpegDir，此处只负责取配置。
  handleTraced('getFfmpegStatus', (_event: IpcMainInvokeEvent, dir?: string) => inspectFfmpegDir(dir ?? Database.instance().getConfig('ffmpegDirectory')))

  // 网络诊断：对核心服务域名逐一轻量探测（设置页「网络诊断」），目标清单在 net-diagnose.ts
  handleTraced('netDiagnose', async () => diagnoseTargets())
}
