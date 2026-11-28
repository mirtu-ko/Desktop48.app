import http from 'node:http'
import { debug, error, log } from './logger'
import { createStreamIdleGuard, STREAM_IDLE_TIMEOUT_MS } from './stream-idle-guard'
import { parseStreamRequestPath } from './stream-request-path'
import {
  resetStreamServerState,
  setStreamServerExhausted,
  setStreamServerPort,
  setStreamServerUnavailable,
  STREAM_SERVER_HOST,
  STREAM_SERVER_MAX_PORT,
  STREAM_SERVER_MIN_PORT,
} from './stream-server-state'

const liveFlvPathRegex = /^\/live\/([^/]+)\.flv$/

export interface FlvStreamProcessLike {
  pid?: number
  stdout: NodeJS.ReadableStream & { unpipe: (destination?: NodeJS.WritableStream) => unknown }
  killed: boolean
  kill: (signal?: NodeJS.Signals | number) => boolean
  on: (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown
}

export interface LiveStreamServerOptions {
  /** 根据 liveId 创建 FFmpeg 转流进程（由 app.ts 注入，避免与 stream.ts 循环依赖） */
  createFlvStreamProcess: (liveId: string) => FlvStreamProcessLike
  /** 空闲超时阈值（毫秒）；缺省使用 STREAM_IDLE_TIMEOUT_MS */
  idleTimeoutMs?: number
}

// 渲染进程的来源：生产环境从 file:// 加载（Origin 为 'null'），开发环境是 electron-vite 的 dev server。
// 其余来源（例如系统浏览器里打开的任意网页）一律拒绝，避免本机网页通过 CORS 读走直播流。
function isAllowedOrigin(origin: string) {
  if (origin === 'null' || origin.startsWith('file://'))
    return true

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!rendererUrl)
    return false

  try {
    return origin === new URL(rendererUrl).origin
  }
  catch {
    return false
  }
}

/**
 * 本地 HTTP-FLV 请求处理器（无网络监听副作用，供 startLocalStreamServer 与单测复用）：
 * 1. 把渲染进程要播放的本地地址映射到直播会话
 * 2. 把 FFmpeg 的 stdout 直接作为 HTTP-FLV 响应输出给播放器
 */
export function createLiveStreamRequestHandler(options: LiveStreamServerOptions): http.RequestListener {
  const { createFlvStreamProcess, idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS } = options

  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')

    // 无 Origin 头的请求（同源导航、非浏览器客户端）不需要 CORS 授权，直接放行。
    const origin = req.headers.origin
    if (origin) {
      if (!isAllowedOrigin(origin)) {
        res.writeHead(403)
        res.end('Forbidden origin')
        return
      }

      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const requestPath = parseStreamRequestPath(req.url)
    if (requestPath === null) {
      res.writeHead(400)
      res.end('Bad request path')
      return
    }

    const liveMatch = requestPath.match(liveFlvPathRegex)

    if (!liveMatch) {
      res.writeHead(404)
      res.end('File not found')
      return
    }

    const liveId = liveMatch[1]
    debug(`[http-server.ts] 收到播放请求: ${requestPath} → liveId=${liveId}`)

    try {
      const ffmpeg = createFlvStreamProcess(liveId)
      debug(`[http-server.ts] 已为 ${liveId} spawn FFmpeg 转流进程, pid=${ffmpeg.pid}`)
      let responseClosed = false
      let hasReceivedData = false
      // 上游连接还活着但不再吐数据时，FFmpeg 不会退出；由守卫结束响应以触发播放器重连
      let idleGuard: ReturnType<typeof createStreamIdleGuard> | null = null

      // 浏览器标签切换、播放器销毁或用户关闭页面时，都要尽快结束对应 FFmpeg。
      const closeResponse = () => {
        if (responseClosed)
          return

        responseClosed = true
        idleGuard?.dispose()
        debug(`[http-server.ts] 关闭 ${liveId} 的响应与转流管道（收到过数据: ${hasReceivedData}）`)
        try {
          ffmpeg.stdout.unpipe(res)
        }
        catch (err) {
          error('[http-server.ts] 断开直播流管道失败:', err)
        }

        try {
          if (!ffmpeg.killed)
            ffmpeg.kill('SIGKILL')
        }
        catch (err) {
          error('[http-server.ts] 关闭直播流进程失败:', err)
        }
      }

      req.on('close', closeResponse)
      res.on('close', closeResponse)
      res.on('finish', closeResponse)
      req.on('aborted', closeResponse)

      // 先于 pipe 注册：收到首块流数据时再发 200 FLV 头，未出首帧即失败时可返回真实 502/504
      ffmpeg.stdout.on('data', () => {
        if (!hasReceivedData) {
          hasReceivedData = true
          debug(`[http-server.ts] ${liveId} 收到首帧流数据，开始向播放器输出`)
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'video/x-flv',
              'Connection': 'close',
            })
          }
        }
        idleGuard?.touch()
      })

      idleGuard = createStreamIdleGuard(() => {
        if (responseClosed)
          return
        debug(`[http-server.ts] ${liveId} 超过 ${idleTimeoutMs}ms 无流数据，结束响应以触发重连`)
        // 未发出 FLV 头时返回 504；已出流后空结束，复用既有 ended 断流重试链
        if (!res.headersSent)
          res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('')
        closeResponse()
      }, idleTimeoutMs)

      ffmpeg.stdout.on('error', (err) => {
        error('[http-server.ts] 读取直播流失败:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Read error')
        }
        else {
          res.end('')
        }
        closeResponse()
      })

      ffmpeg.on('close', (code, signal) => {
        if (responseClosed)
          return

        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL'
            ? ''
            : 'Stream closed unexpectedly')
        }
        else {
          // FLV 200 头已发出：不再向二进制流追加纯文本，防止 mpegts 报致命解析错
          res.end('')
        }
        closeResponse()
      })

      ffmpeg.stdout.pipe(res)
    }
    catch (err: any) {
      error('[http-server.ts] 创建直播流失败:', err)
      res.writeHead(500)
      res.end(err?.message || 'Stream error')
    }
  }
}

let activeServer: http.Server | null = null

/** 启动主进程本地流媒体服务（按 8080-8090 区间向后退避监听回环地址）；幂等 */
export function startLocalStreamServer(
  createFlvStreamProcess: LiveStreamServerOptions['createFlvStreamProcess'],
): http.Server {
  if (activeServer)
    return activeServer

  const server = http.createServer(createLiveStreamRequestHandler({ createFlvStreamProcess }))
  activeServer = server
  let port = STREAM_SERVER_MIN_PORT

  // 上次退出的残留监听或外部程序可能占用端口，按 minPort-maxPort 区间向后退避尝试。
  // error 监听只注册一次：放进 tryListen 会随重试累积，一次 EADDRINUSE 会被多个监听器各处理一次。
  const tryListen = () => {
    server.listen(port, STREAM_SERVER_HOST)
  }

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      log(`[http-server.ts] 端口 ${port} 已被占用，尝试下一个端口`)
      if (port < STREAM_SERVER_MAX_PORT) {
        port++
        tryListen()
      }
      else {
        if (activeServer === server)
          activeServer = null
        setStreamServerExhausted(true)
        error('[http-server.ts] 无法找到可用端口，直播播放将不可用')
      }
    }
    else {
      error('[http-server.ts] 服务器错误:', err)
      if (!server.listening) {
        if (activeServer === server)
          activeServer = null
        setStreamServerUnavailable(`本地流媒体服务启动失败（${err.code || err.message || '未知错误'}），请检查权限或重启本应用`)
      }
    }
  })

  server.on('listening', () => {
    log(`[http-server.ts] 本地流媒体服务器监听端口 ${port}`)
    setStreamServerPort(port)
  })

  tryListen()
  return server
}

/** 应用退出前关闭本地流媒体监听并复位端口状态；幂等 */
export function stopLocalStreamServer(): void {
  if (!activeServer)
    return
  const server = activeServer
  activeServer = null
  resetStreamServerState()
  server.close()
}
