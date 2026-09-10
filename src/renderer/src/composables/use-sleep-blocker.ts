import { ref } from 'vue'

/**
 * 播放防休眠：持有 Electron 主进程的 powerSaveBlocker id，
 * 播放开始时 acquire、暂停/结束/卸载时 release。
 * LivePlayer（直播）与 PlaybackPlayer（录播）共用。
 *
 * id 是主进程分配的句柄，release 时必须原样传回，否则解除的是别人的锁。
 */
export function useSleepBlocker() {
  const id = ref<number | null>(null)

  async function acquire() {
    if (id.value !== null)
      return
    // ★ 跨进程：preload/index.ts → main/app.ts 的 'preventSleep' handler
    id.value = await window.mainAPI.preventSleep()
  }

  function release() {
    if (id.value === null)
      return
    // ★ 跨进程：preload/index.ts → main/app.ts 的 'allowSleep' handler
    window.mainAPI.allowSleep(id.value)
    id.value = null
  }

  return { acquire, release }
}
