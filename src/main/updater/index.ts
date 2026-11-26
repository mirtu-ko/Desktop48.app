/**
 * 更新模块入口：环境判定 + 单例 + 启动编排。状态机在 engine.ts，平台差异在 backend.ts。
 */
import type { UpdaterState } from './types'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { log } from '../logger'
import { createInAppBackend, createManualBackend } from './backend'
import { UpdaterEngine } from './engine'
import { startupCheckDelay } from './policy'
import { DOWNLOAD_PAGE_URL } from './sources'

/** dev 默认不检查更新：源码版本号常落后于线上，检查只会天天提示。 */
const DEV_UPDATE_CHECK_ENV = 'DESKTOP48_DEV_UPDATE_CHECK'

/** 判定顺序即能力由强到弱：dev 跳过 → mac 只能手动 → 免安装版也不支持。 */
export type UpdaterSupport
  = | { ok: true, mode: 'in-app' | 'manual' }
    | { ok: false, reason: string, url?: string }

export function resolveUpdaterSupport(): UpdaterSupport {
  const devFlag = process.env[DEV_UPDATE_CHECK_ENV] === '1'

  if (!app.isPackaged && !devFlag)
    return { ok: false, reason: '开发模式下不检查更新' }

  // macOS 未签名也没有 zip target；dev 强制开启时同样只查版本号
  if (process.platform === 'darwin' || devFlag)
    return { ok: true, mode: 'manual' }

  // Linux 仅 AppImage 支持 electron-updater 应用内更新（依赖 APPIMAGE 环境变量）；
  // .deb 等系统包走手动更新（查版本号并引导至下载页/直链），否则下载安装会直接报错
  if (process.platform === 'linux' && !process.env.APPIMAGE)
    return { ok: true, mode: 'manual' }

  // 免安装版没有 app-update.yml，electron-updater 会在 checkForUpdates 时直接抛错
  if (!existsSync(path.join(process.resourcesPath, 'app-update.yml')))
    return { ok: false, reason: '当前为免安装版，不支持自动更新（请使用安装包版本）', url: DOWNLOAD_PAGE_URL }

  return { ok: true, mode: 'in-app' }
}

let engine: UpdaterEngine | null = null

/** 重复调用无副作用；必须在 app ready 之后（要读 userData 路径）。 */
export function initUpdater(): void {
  if (engine)
    return

  const support = resolveUpdaterSupport()
  if (!support.ok) {
    log('[updater] 不检查更新：', support.reason)
    engine = new UpdaterEngine({ backend: null, unsupported: { reason: support.reason, url: support.url } })
    return
  }

  engine = new UpdaterEngine({
    backend: support.mode === 'in-app' ? createInAppBackend() : createManualBackend(),
  })
  log(`[updater] 更新通道：${support.mode === 'in-app' ? '应用内更新' : '手动下载'}`)
}

function currentEngine(): UpdaterEngine | null {
  if (!engine)
    log('[updater] 更新模块尚未初始化，忽略本次调用')
  return engine
}

/**
 * 启动后的那一次静默检查（唯一一次）。延迟 + 抖动：先让窗口画出来，也别让开机一批人同时打镜像。
 */
export function scheduleStartupCheck(): void {
  const delay = startupCheckDelay()
  const timer = setTimeout(() => {
    void checkForUpdates({ silent: true })
  }, delay)
  timer.unref()
}

/** 上次若有已下好的包，本次启动先装掉；true 表示本进程即将被安装器接管。 */
export function startPendingInstall(): Promise<boolean> {
  const instance = currentEngine()
  return instance ? instance.startPendingInstall() : Promise.resolve(false)
}

export function getUpdaterState(): UpdaterState {
  const instance = currentEngine()
  if (instance)
    return instance.getState()
  // 理论上 IPC 不会这么早被调用，给一个自洽的空态
  return {
    phase: 'idle',
    currentVersion: app.getVersion(),
    checkedAt: null,
    candidate: null,
    download: null,
    error: null,
    unsupported: null,
    notice: null,
  }
}

export function checkForUpdates(options: { silent?: boolean } = {}): Promise<UpdaterState> {
  const instance = currentEngine()
  return instance ? instance.check(options) : Promise.resolve(getUpdaterState())
}

/** 自动下载失败后的「重试」。 */
export function downloadUpdate(): Promise<UpdaterState> {
  const instance = currentEngine()
  return instance ? instance.download() : Promise.resolve(getUpdaterState())
}

export function installUpdate(): void {
  currentEngine()?.install()
}

export function dismissUpdateNotice(): UpdaterState {
  const instance = currentEngine()
  return instance ? instance.dismiss() : getUpdaterState()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export { DOWNLOAD_PAGE_URL }
