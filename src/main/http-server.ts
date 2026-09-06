import http from 'node:http'
import { debug, error, log } from './logger'
import { createFlvStreamProcess } from './stream'

let _serverPort = 8080
export const serverPort = () => _serverPort

// 只监听回环地址：本地流媒体服务无鉴权，绑定 0.0.0.0 会让局域网内任何设备都能拉走直播流。
export const serverHost = '127.0.0.1'

// 端口全部耗尽时置位。此后 createLiveStream 应显式拒绝，
// 否则渲染进程会拿到一个指向死端口的播放地址，播放静默失败且无任何提示。
let _serverPortExhausted = false

// 监听端口区间：8080 起逐个向后退避，至 8090
const minPort = 8080
const maxPort = 8090

/** 本地流媒体服务是否可用；端口耗尽时抛出用户可读的错误（经 IPC 回传渲染层弹窗） */
export function assertLocalServerAvailable(): void {
  if (_serverPortExhausted) {
    throw new Error(`本地流媒体服务启动失败（端口 ${minPort}-${maxPort} 均被占用），请关闭占用端口的应用后重启本应用`)
  }
}

const liveFlvPathRegex = /^\/live\/([^/]+)\.flv$/

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

// 本地 HTTP 服务只负责两件事：
// 1. 把渲染进程要播放的本地地址映射到直播会话
// 2. 把 FFmpeg 的 stdout 直接作为 HTTP-FLV 响应输出给播放器
const server = http.createServer((req, res) => {
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

  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const requestPath = decodeURIComponent(requestUrl.pathname)
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

    res.writeHead(200, {
      'Content-Type': 'video/x-flv',
      'Connection': 'close',
    })

    // 浏览器标签切换、播放器销毁或用户关闭页面时，都要尽快结束对应 FFmpeg。
    const closeResponse = () => {
      if (responseClosed)
        return

      responseClosed = true
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

    ffmpeg.stdout.on('data', () => {
      if (!hasReceivedData)
        debug(`[http-server.ts] ${liveId} 收到首帧流数据，开始向播放器输出`)
      hasReceivedData = true
    })

    ffmpeg.stdout.on('error', (err) => {
      error('[http-server.ts] 读取直播流失败:', err)
      if (!res.headersSent)
        res.writeHead(500)
      res.end('Read error')
      closeResponse()
    })

    ffmpeg.on('close', (code, signal) => {
      if (responseClosed)
        return

      if (!res.headersSent) {
        res.writeHead(hasReceivedData ? 200 : 502)
      }

      res.end(code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL'
        ? ''
        : 'Stream closed unexpectedly')
      closeResponse()
    })

    ffmpeg.stdout.pipe(res)
  }
  catch (err: any) {
    error('[http-server.ts] 创建直播流失败:', err)
    res.writeHead(500)
    res.end(err?.message || 'Stream error')
  }
})

let port = minPort

// 上次退出的残留监听或外部程序可能占用端口，按 minPort-maxPort 区间向后退避尝试。
function tryListen() {
  server.listen(port, serverHost)
    .on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        log(`[http-server.ts] 端口 ${port} 已被占用，尝试下一个端口`)
        if (port < maxPort) {
          port++
          tryListen()
        }
        else {
          _serverPortExhausted = true
          error('[http-server.ts] 无法找到可用端口，直播播放将不可用')
        }
      }
      else {
        error('[http-server.ts] 服务器错误:', err)
      }
    })
    .on('listening', () => {
      log(`[http-server.ts] 本地流媒体服务器监听端口 ${port}`)
      _serverPort = port
    })
}

tryListen()

server.on('error', (err) => {
  error('[http-server.ts] 本地流媒体服务器错误:', err)
})
