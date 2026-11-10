import type { UpdaterState } from '@preload/ipc-contract'
import type { MessageHandler } from 'element-plus'
import type { ComputedRef, Ref } from 'vue'
import Constants from '@renderer/utils/constants'
import { ElButton, ElMessage } from 'element-plus'
import { h, watch } from 'vue'
import { useRouter } from 'vue-router'
import { trackEvent } from '../utils/umami'
import { useUpdater } from './use-updater'

/**
 * 首页新版本 toast：设置页的更新行是被动入口，这里在首页补一条可操作的常驻提示。
 *
 * 三条约束：
 * - 只在首页（isHome）弹出；状态在此期间到达时先暂存，切回首页再补弹。
 * - 同一版本在一次会话里只提示一次：更新状态会被广播/手动检查反复推送，不能刷屏。
 * - 只做「提示 + 引导」，下载与重启仍留在设置页由用户确认（macOS 还要跳下载页）。
 *
 * 由 App.vue 挂载：根组件不在 KeepAlive 内，订阅一次即可，避免页面缓存导致的重复订阅。
 * 独立播放窗不调用本模块。
 */

interface PendingNotice {
  version: string
  ready: boolean
}

/** 已提示过的版本号；模块级状态在页面重挂后仍有效 */
const notifiedVersions = new Set<string>()
/** 首页不可见期间到达的提示 */
let pending: PendingNotice | null = null
/** 当前展示中的消息，弹出新版本前先关掉旧的 */
let shown: MessageHandler | null = null

function isNoticeState(s: UpdaterState): s is Extract<UpdaterState, { phase: 'available' | 'ready' }> {
  return s.phase === 'available' || s.phase === 'ready'
}

export function useHomeUpdateToast(isHome: Ref<boolean> | ComputedRef<boolean>): void {
  const router = useRouter()
  const { state } = useUpdater()

  /** 首页可见且没有正在展示的提示时落地暂存 */
  function flush(): void {
    if (!isHome.value || !pending || shown)
      return
    const notice = pending
    pending = null
    notifiedVersions.add(notice.version)
    show(notice)
  }

  function show(notice: PendingNotice): void {
    let handler: MessageHandler | null = null

    const content = h('div', { class: 'update-toast' }, [
      h('div', { class: 'update-toast__title' }, notice.ready
        ? `新版本 v${notice.version} 已下载`
        : `发现新版本 v${notice.version}`),
      h('div', { class: 'update-toast__desc' }, notice.ready
        ? '重启后生效，前往「设置 → 应用」完成安装'
        : '前往「设置 → 应用」查看更新内容并升级'),
      h('div', { class: 'update-toast__actions' }, [
        h(ElButton, {
          type: 'primary',
          size: 'small',
          onClick: () => {
            trackEvent('update:toast_go', { version: notice.version })
            handler?.close()
            // focus 由设置页消费一次，滚动到「应用 → 版本」行；不用 useSettingsNav 是因为要带定位参数
            void router.push({ path: Constants.Menu.SETTING, query: { focus: 'update' } })
          },
        }, () => '去更新'),
        h(ElButton, {
          text: true,
          size: 'small',
          onClick: () => handler?.close(),
        }, () => '稍后'),
      ]),
    ])

    handler = ElMessage({
      message: content,
      customClass: 'update-toast-message',
      duration: 0,
      showClose: true,
      // 标题栏固定 36px（FLOAT_BAR_HEIGHT），下移一条避免压住拖拽区
      offset: 48,
      onClose: () => {
        if (shown === handler)
          shown = null
        // 关闭后若期间又来了更新的版本，补弹暂存的提示
        flush()
      },
    })
    shown = handler
    trackEvent('update:toast_show', { version: notice.version })
  }

  watch(state, (next) => {
    if (!isNoticeState(next) || notifiedVersions.has(next.version))
      return
    pending = { version: next.version, ready: next.phase === 'ready' }
    flush()
  }, { immediate: true })

  watch(isHome, (home) => {
    if (home)
      flush()
  }, { immediate: true })
}
