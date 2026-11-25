/**
 * 更新状态的渲染端单例：设置页与顶部横幅共用一份。
 * 主进程已算好该不该提示，这里只订阅广播、回取一次快照、转发用户动作。
 */
import type { UpdaterState } from '@preload/ipc-contract'
import { trackEvent } from '@renderer/utils/umami'
import { bannerContent, describeUpdater, resolveUpdaterAction } from '@renderer/utils/updater-view'
import { computed, ref } from 'vue'

const EMPTY_STATE: UpdaterState = {
  phase: 'idle',
  currentVersion: '',
  checkedAt: null,
  candidate: null,
  download: null,
  error: null,
  unsupported: null,
  notice: null,
}

const state = ref<UpdaterState>({ ...EMPTY_STATE })
const version = ref('')
const checking = ref(false)

// 唯一写入口是 updaterState 广播（外加启动时那一次快照）。IPC 回包一律不回写：
// 主进程先广播、后 resolve，到达顺序无保证——check 的回包里是 downloading 中间态，
// 若晚于 ready 广播落地就会倒退成下载中，且再无广播来纠正。

let started = false

/** 先订阅再回取快照，否则会漏掉中间那次广播。 */
function start(): void {
  if (started)
    return
  started = true

  window.mainAPI.updaterState((next) => {
    state.value = next
    if (next.currentVersion)
      version.value = next.currentVersion
    if (next.phase !== 'checking')
      checking.value = false
  })

  // 快照只用来补「订阅前已查过一次」，不能覆盖广播结果
  void window.mainAPI.updaterGetState().then((snapshot) => {
    if (state.value.phase === 'idle')
      state.value = snapshot
    if (!version.value && snapshot.currentVersion)
      version.value = snapshot.currentVersion
  }).catch(() => {})

  void window.mainAPI.getAppVersion().then((value) => {
    if (!version.value)
      version.value = value
  }).catch(() => {})
}

/** 用户主动检查；启动检查由主进程调度。 */
async function check(): Promise<void> {
  if (checking.value)
    return
  checking.value = true
  trackEvent('update:check')
  try {
    // 只等它做完，结果一律等广播
    await window.mainAPI.updaterCheck()
  }
  catch {
    // 主进程把失败折进了状态；走到这里说明 IPC 断了，保持原状态
  }
  finally {
    checking.value = false
  }
}

/** 自动下载失败后的重试。 */
async function retryDownload(): Promise<void> {
  try {
    await window.mainAPI.updaterDownload()
  }
  catch {}
}

/** 退出并安装（安装器接管后进程会重启）。 */
function install(): void {
  trackEvent('update:install')
  void window.mainAPI.updaterInstall().catch(() => {})
}

/** 横幅「稍后」：同一版本不再提示。 */
async function dismiss(): Promise<void> {
  trackEvent('update:banner_dismiss', { version: state.value.notice?.version ?? '' })
  try {
    await window.mainAPI.updaterDismiss()
  }
  catch {}
}

export function useUpdater() {
  start()
  return {
    state,
    version,
    checking,
    /** 设置页卡片用的派生文本/动作 */
    description: computed(() => describeUpdater(state.value)),
    action: computed(() => resolveUpdaterAction(state.value)),
    banner: computed(() => bannerContent(state.value)),
    check,
    retryDownload,
    install,
    dismiss,
  }
}
