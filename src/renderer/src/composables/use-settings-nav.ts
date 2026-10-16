import type { Router } from 'vue-router'
import Constants from '@renderer/utils/constants'
import { getCurrentInstance } from 'vue'

/**
 * 「引导用户去设置页」的唯一入口（各前置校验守卫共用）。
 *
 * 三种上下文都要覆盖，优先级：显式注入 → 当前组件实例的 $router → main.ts 安装的全局 Router。
 * - 组件 setup 内（播放器、页面）走 $router；
 * - 组件之外（stores/float-players.ts 这类纯模块）取不到 $router，只能依赖 installSettingsRouter。
 *
 * 独立播放窗刻意不装 Router，那里三级全部落空 → settingsName 自动降级为「主窗口「设置」」，
 * 提示用户去主窗口操作，而不是给一个点了没反应的按钮。
 *
 * ★ 全局 Router 只在主窗口分支安装：播放窗的模块实例没有它，也就不会出现
 * 「在播放窗里 push 主窗口路由」这种跨窗错跳。
 */
let installedRouter: Router | undefined

/** 主窗口启动时安装一次，供非 setup 上下文使用（main.ts 调用） */
export function installSettingsRouter(router: Router): void {
  installedRouter = router
}

/** 仅 setup 期间有值；出了 setup（点击回调等）恒为 undefined */
function resolveSetupRouter(): Router | undefined {
  const globalProperties = getCurrentInstance()?.appContext.config.globalProperties as
    | { $router?: Router }
    | undefined
  return globalProperties?.$router
}

export function useSettingsNav(router?: Router) {
  // 必须在调用点解析并定住：getCurrentInstance 出了 setup 就取不到，
  // 若推迟到点击回调里再取，组件内的跳转会静默失效
  const target = router ?? resolveSetupRouter() ?? installedRouter
  /** 提示文案里对设置页的称呼：拿不到 Router（播放窗）时说明要去主窗口 */
  const settingsName = target ? '「设置」' : '主窗口「设置」'

  function openSettings(): void {
    void target?.push(Constants.Menu.SETTING)
  }

  return { settingsName, openSettings }
}
