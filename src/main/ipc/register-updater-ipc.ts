/** 应用更新 IPC：只做通道接线，逻辑在 main/updater.ts。 */
import { checkForUpdates, downloadUpdate, getAppVersion, getUpdaterState, installUpdate } from '../updater'
import { handleTraced } from './trace'

export function registerUpdaterIPC(): void {
  handleTraced('getAppVersion', () => getAppVersion())

  handleTraced('updaterGetState', () => getUpdaterState())

  handleTraced('updaterCheck', () => checkForUpdates())

  handleTraced('updaterDownload', () => downloadUpdate())

  handleTraced('updaterInstall', () => installUpdate())
}
