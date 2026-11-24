/**
 * 应用配置相关 IPC 通道的集中注册。
 *
 * 配置独立存放在 userData/app-config.json（见 main/config-store.ts），与成员库 database.json 分离，
 * 因此单独成域：改一次设置只写 200 B 左右的配置文件，不动 1 MB+ 的成员库。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import type { ConfigKey } from '@common/app-config'
import { parseConfigValue } from '@common/app-config'
import { ConfigStore } from '../config-store'
import { handleTraced } from './trace'

export function registerConfigIPC(): void {
  const store = () => ConfigStore.instance()

  handleTraced('getConfig', async (_event, key: ConfigKey) => store().getConfig(key))
  // IPC 线格式仍是 string：入口处收窄一次，非法键/取值在此抛错，不落库
  handleTraced('setConfig', async (_event, key: ConfigKey, value: string) => store().setConfig(key, parseConfigValue(key, value)))
}
