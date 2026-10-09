/**
 * 应用更新 IPC 通道注册。
 *
 * 逻辑与状态归 main/updater.ts，这里只做通道到函数的接线
 * （与 register-window-ipc.ts 的分工一致）。
 * 通道清单与 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import { checkForUpdates, downloadUpdate, getAppVersion, getUpdaterState, installUpdate } from '../updater'
import { handleTraced } from './trace'

export function registerUpdaterIPC(): void {
  // 当前版本号：设置页「应用更新」标题旁展示
  handleTraced('getAppVersion', () => getAppVersion())

  // 渲染端挂载时回取一次快照；后续状态变化走 updaterState 广播事件
  handleTraced('updaterGetState', () => getUpdaterState())

  // 手动检查；失败已折进返回状态，渲染端无需 try/catch
  handleTraced('updaterCheck', () => checkForUpdates())

  handleTraced('updaterDownload', () => downloadUpdate())

  handleTraced('updaterInstall', () => installUpdate())
}
