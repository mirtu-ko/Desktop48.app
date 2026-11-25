import type { ClearCacheResult, StorageUsage } from '@preload/ipc-contract'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { app, session } from 'electron'
import { log, warn } from './logger'

/**
 * 缓存占用统计与浏览器缓存清理的唯一口径：设置页卡片与启动阈值清理共用。
 * 只统计/清理缓存目录——localStorage 存的是用户设置（置顶、房间快照、密度），清了等于清配置；
 * 登录凭证在 userData 的加密文件里，不受浏览器存储清理影响。
 * Chromium 缓存只有一个池子、无法按 URL 驱逐：头像/封面是复用热数据、消息图片是一次性冷数据，
 * 靠磁盘上限 + LRU 让冷数据先淘汰、热数据留池；手动清理只当「立刻回收磁盘」的逃生口。
 */

/**
 * Chromium HTTP 缓存硬上限（--disk-cache-size），512MB 远大于复用的头像/封面热集合。
 * 超限由 Chromium 按 LRU 淘汰，先出局的是只看一次的消息图片；直播/回放/录制不进这个缓存。
 */
export const DISK_CACHE_LIMIT_BYTES = 512 * 1024 * 1024

/** 兜底清理阈值 1GB：覆盖 HTTP 上限管不到的代码/着色器缓存与历史文件；正常到不了 */
export const CACHE_AUTO_CLEAN_THRESHOLD_BYTES = 1024 * 1024 * 1024

/** 启动后延迟清理：避开首屏渲染与登录请求，不在用户刚打开应用时抢磁盘 IO */
const AUTO_CLEAN_DELAY_MS = 20 * 1000

/**
 * 计入「缓存」的目录（相对 userData），口径与 clearData(['cache']) 一致；
 * GPUPersistentCache 存 WebGPU 持久化数据、BrowsingDataRemover 不清，故不列。
 */
export const BROWSER_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'Shared Dictionary',
  'VideoDecodeStats',
] as const

/** 成员库文件名（database.json 与其备份/隔离文件同前缀） */
const DATABASE_FILE = 'database.json'
const FFMPEG_DIR = 'ffmpeg'

/** 递归统计目录占用；目录不存在或文件遍历中被删按 0 处理，不跟随符号链接 */
export async function directorySize(root: string): Promise<number> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  }
  catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isSymbolicLink())
      continue
    if (entry.isDirectory()) {
      total += await directorySize(fullPath)
      continue
    }
    if (!entry.isFile())
      continue
    try {
      total += (await stat(fullPath)).size
    }
    catch {
      // 并发写入/淘汰时文件可能已消失，统计不需要精确到字节
    }
  }
  return total
}

/** 汇总 userData 占用（纯 IO，不依赖 app，便于单测）；databaseBytes 含 database.json 及其备份/隔离文件 */
export async function collectStorageUsage(userDataDir: string): Promise<StorageUsage> {
  const cacheSizes = await Promise.all(
    BROWSER_CACHE_DIRS.map(dir => directorySize(path.join(userDataDir, dir))),
  )

  let databaseBytes = 0
  try {
    for (const entry of await readdir(userDataDir, { withFileTypes: true })) {
      if (!entry.isFile())
        continue
      if (entry.name !== DATABASE_FILE && !entry.name.startsWith(`${DATABASE_FILE}.`))
        continue
      try {
        databaseBytes += (await stat(path.join(userDataDir, entry.name))).size
      }
      catch {
        // 文件可能正被替换
      }
    }
  }
  catch {
    // userData 尚未创建
  }

  return {
    cacheBytes: cacheSizes.reduce((sum, size) => sum + size, 0),
    databaseBytes,
    ffmpegBytes: await directorySize(path.join(userDataDir, FFMPEG_DIR)),
    cacheLimitBytes: DISK_CACHE_LIMIT_BYTES,
  }
}

/** 读取当前 userData 的占用明细（IPC getStorageUsage 的实现） */
export function getStorageUsage(): Promise<StorageUsage> {
  return collectStorageUsage(app.getPath('userData'))
}

/**
 * 清理缓存（IPC clearCache 的实现）。用 clearData(['cache']) 而非无参 clearStorageData()：
 * 后者会连 localStorage / IndexedDB / Cookies 一起清，丢掉用户设置与登录态。
 * in-flight 守卫放在这里，手动清理与启动兜底清理共用：并发两次 clearData 会让 before/after 互相污染，
 * 两个入口拿到的都是同一次结果。
 */
let clearing: Promise<ClearCacheResult> | null = null

export function clearBrowserCache(): Promise<ClearCacheResult> {
  clearing ??= runClearBrowserCache().finally(() => {
    clearing = null
  })
  return clearing
}

async function runClearBrowserCache(): Promise<ClearCacheResult> {
  const userDataDir = app.getPath('userData')
  const before = await collectStorageUsage(userDataDir)
  try {
    await session.defaultSession.clearData({ dataTypes: ['cache'] })
  }
  catch (error) {
    // 清理失败通常是 session 未就绪，向上抛给渲染层提示
    warn('[cache-storage] 清理浏览器缓存失败:', error)
    throw error
  }
  const usage = await collectStorageUsage(userDataDir)
  const freedBytes = Math.max(0, before.cacheBytes - usage.cacheBytes)
  log('[cache-storage] 缓存已清理:', { before: before.cacheBytes, after: usage.cacheBytes, freedBytes })
  return { freedBytes, usage }
}

/** 启动后延迟检查一次，仅超过阈值才清；定时器 unref，退出应用不被后台任务拖住 */
export function scheduleCacheAutoClean(): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const usage = await getStorageUsage()
        if (usage.cacheBytes <= CACHE_AUTO_CLEAN_THRESHOLD_BYTES)
          return
        log('[cache-storage] 缓存超过阈值，自动清理:', usage.cacheBytes)
        await clearBrowserCache()
      }
      catch (error) {
        // 尽力而为：失败不影响使用，也不弹窗打扰
        warn('[cache-storage] 自动清理缓存失败:', error)
      }
    })()
  }, AUTO_CLEAN_DELAY_MS)
  timer.unref?.()
}
