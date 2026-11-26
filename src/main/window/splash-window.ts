/**
 * 启动画面：在凭证载入 / 更新器就位等异步启动阶段，先展示一个无边框的动画窗口，
 * 主窗口 ready-to-show 时与主窗口交叉淡入淡出，避免启动过程中出现空窗或生硬闪现。
 * 纯 CSS 动画 + data URL 页面，不依赖渲染层构建产物，dev / 生产表现一致。
 */
import { readFileSync } from 'node:fs'
import { BrowserWindow, screen } from 'electron'
import icon from '../../../resources/icon.png?asset'
import { log } from '../logger'

/** 启动画面尺寸（正方形，工作区居中） */
const SPLASH_SIZE = 320
/** 淡入淡出时长（毫秒），主窗口与启动画面共用，形成同步的交叉过渡 */
const FADE_DURATION = 260
/** 安全网超时（毫秒）：主窗口 ready-to-show 在此之前仍未到来就强制收起启动画面 */
const SAFETY_TIMEOUT = 30_000

let splashWindow: BrowserWindow | null = null
/** 淡出进行中：防止 ready-to-show / before-quit 等多次触发重复收尾 */
let closing = false
/** 安全网定时器：兜住加载失败、渲染崩溃等 ready-to-show 永不到来的路径，画面不会永久悬停 */
let safetyTimer: NodeJS.Timeout | null = null

/** 图标读取失败时的兜底图稿（仍是 data URL，页面无需外部资源） */
const FALLBACK_ICON = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#6d5ae0"/><text x="48" y="62" font-size="38" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">48</text></svg>')}`

function splashPage(iconDataUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Desktop48</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    background: radial-gradient(120% 120% at 50% 0%, #ffffff 0%, #f2effc 55%, #e9e4fb 100%);
    border-radius: 22px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }
  .halo {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 150px;
    height: 150px;
    margin: -75px 0 0 -75px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(109, 90, 224, .22) 0%, rgba(109, 90, 224, 0) 70%);
    animation: breathe 2.4s ease-in-out infinite;
    pointer-events: none;
  }
  .logo {
    position: relative;
    width: 96px;
    height: 96px;
    animation: pop .7s cubic-bezier(.2, .9, .25, 1.2) both;
  }
  .logo img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    -webkit-user-drag: none;
    filter: drop-shadow(0 8px 16px rgba(79, 63, 196, .28));
  }
  .title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: .5px;
    color: #4f3fc4;
    animation: rise .6s .15s ease-out both;
  }
  .bar {
    width: 132px;
    height: 4px;
    border-radius: 999px;
    background: rgba(109, 90, 224, .14);
    overflow: hidden;
    animation: rise .6s .25s ease-out both;
  }
  .bar::after {
    content: "";
    display: block;
    width: 45%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #6d5ae0, #a89df6, #ff8fb8);
    animation: slide 1.25s ease-in-out infinite;
  }
  .tip {
    font-size: 12px;
    color: #8f82c9;
    animation: rise .6s .35s ease-out both;
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(.6) translateY(10px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes breathe {
    0%, 100% { transform: scale(.86); opacity: .55; }
    50%      { transform: scale(1.08); opacity: .95; }
  }
  @keyframes slide {
    0%   { transform: translateX(-110%); }
    100% { transform: translateX(245%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .halo, .logo, .title, .bar, .bar::after, .tip { animation: none; }
    .logo, .title, .bar, .tip { opacity: 1; transform: none; }
    .bar::after { transform: translateX(61%); }
  }
</style>
</head>
<body>
  <div class="halo"></div>
  <div class="logo"><img src="${iconDataUrl}" alt="Desktop48" /></div>
  <div class="title">Desktop48</div>
  <div class="bar"></div>
  <div class="tip">正在启动…</div>
</body>
</html>`
}

/** 线性插值窗口透明度；按帧驱动，窗口销毁或退出流程中自动停下 */
function animateOpacity(win: BrowserWindow, from: number, to: number, done?: () => void): void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer)
      return
    }
    const t = Math.min(1, (Date.now() - startedAt) / FADE_DURATION)
    const eased = 1 - (1 - t) ** 3 // easeOutCubic
    win.setOpacity(from + (to - from) * eased)
    if (t >= 1) {
      clearInterval(timer)
      done?.()
    }
  }, 16)
}

/** 收起安全网定时器：两条收尾路径（淡出 / 立即销毁）都会调用 */
function disarmSafetyTimer(): void {
  if (safetyTimer) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
}

/** 布下安全网：启动链路某条路径漏掉收尾时到点自毁，alwaysOnTop 的画面不会永久盖在屏幕上 */
function armSafetyTimer(): void {
  disarmSafetyTimer()
  safetyTimer = setTimeout(() => {
    safetyTimer = null
    log('[splash-window] 启动画面超时未收尾，自动收起')
    closeSplashWindow()
  }, SAFETY_TIMEOUT)
  safetyTimer.unref()
}

/** 判定窗口是否为启动画面：主窗口查找逻辑（showMainWindow 兜底分支）需把它排除 */
export function isSplashWindow(win: BrowserWindow): boolean {
  return win === splashWindow
}

/** 展示启动画面（app ready 后、异步启动步骤之前调用）；已存在时幂等 */
export function showSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed())
    return
  const { workArea } = screen.getPrimaryDisplay()
  const x = workArea.x + Math.round((workArea.width - SPLASH_SIZE) / 2)
  const y = workArea.y + Math.round((workArea.height - SPLASH_SIZE) / 2)
  const win = new BrowserWindow({
    width: SPLASH_SIZE,
    height: SPLASH_SIZE,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    // 纯展示页，无需 preload 与 Node 能力；比主窗口更严格
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  splashWindow = win
  closing = false
  armSafetyTimer()

  let iconDataUrl = FALLBACK_ICON
  try {
    iconDataUrl = `data:image/png;base64,${readFileSync(icon).toString('base64')}`
  }
  catch (error) {
    log('[splash-window] 读取应用图标失败，使用兜底图稿:', error)
  }
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashPage(iconDataUrl))}`)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed())
      win.show()
  })
  win.on('closed', () => {
    if (splashWindow === win)
      splashWindow = null
  })
}

/** 主窗口登场：从透明淡入，与启动画面淡出同步，形成交叉过渡 */
export function fadeInWindow(win: BrowserWindow): void {
  if (win.isDestroyed())
    return
  // 先置透明再 show，避免先闪一帧全不透明窗口；show 必须由这里负责，
  // 调用方 ready-to-show 里不再直接 win.show()
  try {
    win.setOpacity(0)
    win.show()
    animateOpacity(win, 0, 1)
  }
  catch (error) {
    // setOpacity 依赖平台合成器（如 Linux 无 compositor 的 WM）：失败时降级为直接显示，
    // 决不能让主窗口停留在不可见状态，也不能吞掉调用方后续的启动画面收尾
    log('[splash-window] 淡入动画不可用，降级为直接显示:', error)
    win.show()
  }
}

/** 启动画面淡出并销毁；重复调用无副作用 */
export function fadeOutSplashWindow(): void {
  const win = splashWindow
  if (!win || win.isDestroyed() || closing)
    return
  closing = true
  disarmSafetyTimer()
  animateOpacity(win, 1, 0, () => {
    if (!win.isDestroyed())
      win.destroy()
    if (splashWindow === win)
      splashWindow = null
  })
}

/** 立即销毁启动画面：退出、安装器接管等无需过渡的路径 */
export function closeSplashWindow(): void {
  disarmSafetyTimer()
  const win = splashWindow
  if (!win || win.isDestroyed())
    return
  win.destroy()
  splashWindow = null
}
