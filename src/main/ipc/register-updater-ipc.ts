/** 应用更新 IPC：只做通道接线，状态机在 main/updater/engine.ts。 */
import { checkForUpdates, dismissUpdateNotice, downloadUpdate, getAppVersion, getUpdaterState, installUpdate } from '../updater'
import { handleTraced } from './trace'

export function registerUpdaterIPC(): void {
  handleTraced('getAppVersion', () => getAppVersion())

  handleTraced('updaterGetState', () => getUpdaterState())

  // 渲染端只发起「用户主动点检查」这一种；启动检查由主进程自己调度（main/updater/index.ts）
  handleTraced('updaterCheck', () => checkForUpdates())

  handleTraced('updaterDownload', () => downloadUpdate())

  handleTraced('updaterInstall', () => installUpdate())

  handleTraced('updaterDismiss', () => dismissUpdateNotice())
}
