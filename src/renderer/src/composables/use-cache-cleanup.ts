import type { ClearCacheResult, StorageUsage } from '@preload/ipc-contract'
import { computed, ref } from 'vue'

/**
 * 设置页「缓存占用」卡的唯一状态源。口径在主进程 cache-storage.ts，这里只展示数字与触发清理。
 * 状态是模块级单例：keep-alive 反复进出不重闪「计算中」，清理中切走再回来仍见同一进度。
 */

const usage = ref<StorageUsage | null>(null)
const loading = ref(false)
const clearing = ref(false)

/** 字节数转可读文本；整数档不带小数点 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 1024 ** exp
  return `${exp === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`
}

/** 缓存大小；读取未回来时显示占位符而非 0 B */
const cacheText = computed(() => (usage.value ? formatBytes(usage.value.cacheBytes) : '—'))

/** 上限说明：缓存有天花板 */
const limitText = computed(() => (usage.value ? `上限 ${formatBytes(usage.value.cacheLimitBytes)}` : ''))

/** 成员库与 FFmpeg 不清理，避免用户以为会被删 */
const otherText = computed(() => {
  if (!usage.value)
    return ''
  return `成员库 ${formatBytes(usage.value.databaseBytes)}、FFmpeg ${formatBytes(usage.value.ffmpegBytes)} 属数据与依赖，需保留；登录与设置不受清理影响。`
})

/** 读取占用；失败保留旧数字 */
async function refresh(): Promise<void> {
  if (loading.value || clearing.value)
    return
  loading.value = true
  try {
    usage.value = await window.mainAPI.getStorageUsage()
  }
  catch (error) {
    console.error('[useCacheCleanup] 读取存储占用失败:', error)
  }
  finally {
    loading.value = false
  }
}

/** 清理缓存；freedBytes 可能为 0（清理异步落盘，磁盘暂未变化） */
async function clear(): Promise<ClearCacheResult | null> {
  if (clearing.value)
    return null
  clearing.value = true
  try {
    const result = await window.mainAPI.clearCache()
    usage.value = result.usage
    return result
  }
  catch (error) {
    console.error('[useCacheCleanup] 清理缓存失败:', error)
    return null
  }
  finally {
    clearing.value = false
  }
}

export function useCacheCleanup() {
  return {
    usage,
    loading,
    clearing,
    cacheText,
    limitText,
    otherText,
    formatBytes,
    refresh,
    clear,
  }
}
