import type { UpdaterState } from '../../../preload/ipc-contract'
import { onActivated, onMounted, onUnmounted, ref } from 'vue'

/**
 * 自动更新状态与操作。
 *
 * ★ 跨进程：全部经 preload 转到 main/ipc/register-updater-ipc.ts，
 * 状态与逻辑在 main/updater.ts（状态归主进程、本模块只存镜像）。
 *
 * ⚠️ 生命周期同时挂 onMounted + onActivated：
 * 设置页在 KeepAlive 里，只挂 onMounted 时切页回来不会重新订阅；
 * 只挂 onActivated 时组件若不在 KeepAlive 内（预览脚手架直挂页面）则永不触发。
 * 两者都挂，由本 composable 自己接线，调用方无需关心。
 */
export function useUpdater() {
  const state = ref<UpdaterState>({ phase: 'idle' })
  /** 手动检查的请求中标记：首次检查可能数秒无事件，需要按钮 loading 反馈 */
  const checking = ref(false)
  /** 当前应用版本号，取到前为空串（模板里不必等它） */
  const version = ref('')

  let unsubscribe: (() => void) | null = null

  /** 订阅状态广播 + 回取一次快照（订阅在前，避免两者之间的事件丢失） */
  function subscribe() {
    if (unsubscribe)
      return
    unsubscribe = window.mainAPI.updaterState((next) => {
      state.value = next
    })
    // 快照晚于订阅回取：若期间已有新事件到达，以事件为准（不覆盖较新状态）
    void window.mainAPI.updaterGetState().then((snapshot) => {
      if (state.value.phase === 'idle')
        state.value = snapshot
    })
    // 版本号是常量，取到即缓存（切页回来不会重复请求）
    if (!version.value)
      void window.mainAPI.getAppVersion().then((v) => { version.value = v })
  }

  function unsubscribeAll() {
    unsubscribe?.()
    unsubscribe = null
  }

  /** 手动检查更新；失败已折进状态，这里只负责 loading 与提示 */
  async function check() {
    if (checking.value)
      return
    checking.value = true
    try {
      state.value = await window.mainAPI.updaterCheck()
    }
    finally {
      checking.value = false
    }
  }

  /** 用户确认后下载 */
  async function download() {
    await window.mainAPI.updaterDownload()
  }

  /** 退出并安装 */
  function install() {
    window.mainAPI.updaterInstall()
  }

  onMounted(subscribe)
  onActivated(subscribe)
  onUnmounted(unsubscribeAll)

  return { state, checking, version, check, download, install }
}
