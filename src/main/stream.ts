import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isAllowedStreamUrl } from './allowed-hosts'
import { Database } from './database'
import { assertLocalServerAvailable, serverHost, serverPort } from './http-server'
import { debug, error, log } from './logger'

// 直播播放只在这里维护“会话”和“活跃转流进程”的状态。
// IPC 负责注册直播地址，HTTP 端点真正触发 FFmpeg 拉流并输出 HTTP-FLV。
interface StreamSession {
  sessionId: string
  liveId: string
  inputUrl: string
}

const streamSessions = new Map<string, StreamSession>()
const activeStreamProcesses = new Map<string, Set<ReturnType<typeof spawn>>>()

function getSafeLiveId(liveId: string) {
  return liveId.replace(/[^\w-]/g, '_') || 'live'
}

// 对外暴露的直播地址统一走本地 HTTP-FLV 路由，渲染进程不感知底层 FFmpeg 细节。
function getStreamRoute(liveId: string) {
  return `/live/${encodeURIComponent(getSafeLiveId(liveId))}.flv`
}

// 播放和录制都复用用户配置的 FFmpeg，可避免在项目里额外捆绑二进制。
function getFfmpegPath() {
  const ffmpegDir = Database.instance().getConfig('ffmpegDirectory')
  if (!ffmpegDir)
    throw new Error('尚未设置 ffmpeg 目录')

  const ffmpegPath = path.join(
    ffmpegDir,
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  )

  if (!fs.existsSync(ffmpegPath))
    throw new Error('ffmpeg 不存在')

  return ffmpegPath
}

function registerActiveProcess(sessionId: string, process: ReturnType<typeof spawn>) {
  const processSet = activeStreamProcesses.get(sessionId) ?? new Set<ReturnType<typeof spawn>>()
  processSet.add(process)
  activeStreamProcesses.set(sessionId, processSet)
}

function unregisterActiveProcess(sessionId: string, process: ReturnType<typeof spawn>) {
  const processSet = activeStreamProcesses.get(sessionId)
  if (!processSet)
    return

  processSet.delete(process)
  if (processSet.size === 0)
    activeStreamProcesses.delete(sessionId)
}

// 优雅退出（写 'q'）后等待进程自行收尾的期限；超时视为进程卡死，强杀兜底。
// 正常情况下 ffmpeg 写完文件尾毫秒级退出，2 秒足够宽裕。
const GRACEFUL_STOP_TIMEOUT_MS = 2000

function stopProcess(process: ReturnType<typeof spawn>) {
  if (process.exitCode !== null || process.killed)
    return

  try {
    if (process.stdin && !process.stdin.destroyed) {
      process.stdin.write('q')
      process.stdin.end()
      // 写 'q' 成功不代表进程会退出：网络栈 hang 等场景下 ffmpeg 可能永不收尾，
      // 挂超时强杀兜底，避免直播转流进程泄漏（持续占用带宽直到应用退出）
      const timer = setTimeout(() => {
        if (process.exitCode !== null || process.killed)
          return
        error('[stream.ts] FFmpeg 优雅退出超时，强制结束进程')
        forceKill(process)
      }, GRACEFUL_STOP_TIMEOUT_MS)
      timer.unref()
      // 进程如期退出则取消强杀定时器
      process.once('close', () => clearTimeout(timer))
      return
    }
  }
  catch (err) {
    error('[stream.ts] 发送 FFmpeg 退出指令失败:', err)
  }

  forceKill(process)
}

/** SIGTERM 失败再补 SIGKILL */
function forceKill(process: ReturnType<typeof spawn>) {
  try {
    process.kill('SIGTERM')
  }
  catch (err) {
    error('[stream.ts] 发送 FFmpeg 终止信号失败:', err)
    try {
      process.kill('SIGKILL')
    }
    catch (killErr) {
      error('[stream.ts] 强制结束 FFmpeg 失败:', killErr)
    }
  }
}

function stopActiveProcesses(sessionId: string) {
  const processSet = activeStreamProcesses.get(sessionId)
  if (!processSet)
    return

  for (const process of processSet)
    stopProcess(process)
}

export function createFlvStreamProcess(liveId: string) {
  const sessionId = getSafeLiveId(liveId)
  const session = streamSessions.get(sessionId)
  if (!session)
    throw new Error(`直播流不存在: ${liveId}`)

  const ffmpegPath = getFfmpegPath()
  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-rtmp_live',
    'live',
    '-i',
    session.inputUrl,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-f',
    'flv',
    'pipe:1',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  registerActiveProcess(sessionId, ffmpeg)

  ffmpeg.stderr.on('data', (data) => {
    log(`[stream.ts] ffmpeg stderr (${liveId}): ${data}`)
  })

  ffmpeg.on('error', (err) => {
    error(`[stream.ts] ffmpeg error (${liveId}):`, err)
  })

  ffmpeg.on('close', (code, signal) => {
    unregisterActiveProcess(sessionId, ffmpeg)
    log(`[stream.ts] ffmpeg closed (${liveId}), code=${code}, signal=${signal}`)
  })

  return ffmpeg
}

// 渲染进程只需要知道“这个直播可从哪个本地地址播放”，不直接管理 FFmpeg 进程。
// IPC 通道注册在 ipc/register-stream-ipc.ts，这里只导出纯业务函数（可测试、无副作用）。
export async function handleCreateLiveStream(rtmpUrl: string, liveId: string) {
  // 端口耗尽时本地 HTTP 服务不存在，返回 URL 只会让播放器静默连接失败——显式拒绝并说明原因
  assertLocalServerAvailable()
  // rtmpUrl 直接交给 ffmpeg 拉流，必须过白名单，否则渲染层被攻破即可诱导主进程连任意地址
  if (!isAllowedStreamUrl(rtmpUrl))
    throw new Error(`直播流地址不在允许范围内: ${rtmpUrl}`)
  const sessionId = getSafeLiveId(liveId)
  const existingSession = streamSessions.get(sessionId)
  const publicPath = getStreamRoute(liveId)

  if (existingSession && existingSession.inputUrl === rtmpUrl) {
    const url = `http://${serverHost}:${serverPort()}${publicPath}`
    debug(`[stream.ts] 复用已有直播会话: ${liveId} → ${url}`)
    return {
      // 用 127.0.0.1 而非 localhost：localhost 可能解析到 ::1，与回环 IPv4 监听不匹配。
      url,
      liveId,
    }
  }

  streamSessions.set(sessionId, {
    sessionId,
    liveId,
    inputUrl: rtmpUrl,
  })

  const url = `http://${serverHost}:${serverPort()}${publicPath}`
  debug(`[stream.ts] 新建直播会话: ${liveId} → ${url}（FFmpeg 待播放器拉流时由 http-server 触发）`)
  return {
    url,
    liveId,
  }
}

export function handleStopLiveStream(liveId: string) {
  const sessionId = getSafeLiveId(liveId)
  const hadSession = streamSessions.delete(sessionId)
  stopActiveProcesses(sessionId)
  if (hadSession)
    log(`[stream.ts] 已移除直播会话: ${liveId}`)
}

/** 应用退出前清理所有直播会话与转流进程；由 app.ts 的 before-quit 显式调用 */
export function cleanupStreamSessions(): void {
  for (const sessionId of activeStreamProcesses.keys())
    stopActiveProcesses(sessionId)

  streamSessions.clear()
  activeStreamProcesses.clear()
}
