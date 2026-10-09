import type { UpdaterState } from '../../../preload/ipc-contract'
import { onActivated, onMounted, onUnmounted, ref } from 'vue'

/** 自动更新状态与操作；主进程持真相，本模块只维护渲染端镜像。 */
export function useUpdater() {
  const state = ref<UpdaterState>({ phase: 'idle' })
  /** 手动检查的请求中标记。 */
  const checking = ref(false)
  /** 当前应用版本号。 */
  const version = ref('')

  let unsubscribe: (() => void) | null = null

  /** 订阅状态广播，并回取快照与版本号。 */
  function subscribe() {
    if (unsubscribe)
      return
    unsubscribe = window.mainAPI.updaterState((next) => {
      state.value = next
    })
    void window.mainAPI.updaterGetState().then((snapshot) => {
      if (state.value.phase === 'idle')
        state.value = snapshot
    })
    if (!version.value)
      void window.mainAPI.getAppVersion().then((v) => { version.value = v })
  }

  function unsubscribeAll() {
    unsubscribe?.()
    unsubscribe = null
  }

  /** 手动检查更新。 */
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
