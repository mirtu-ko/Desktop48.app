/**
 * 数据库相关 IPC 通道的集中注册。
 *
 * 拆出独立模块的原因：database.ts 里注册会把它变成「import 即有副作用」，
 * 既不可测试，也让依赖方（app.ts）看不到有哪些通道存在。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import { ipcMain } from 'electron'
import { Database } from '../database'

export function registerDatabaseIPC(): void {
  const db = () => Database.instance()

  ipcMain.handle('saveMemberData', async (_event, content) => db().saveMemberData(content))
  ipcMain.handle('getMemberInfo', async (_event, userId) => db().getMemberInfo(userId))
  ipcMain.handle('getBlockedMembers', async () => db().getBlockedMembers())
  ipcMain.handle('setBlockedMembers', async (_event, ids) => db().setBlockedMembers(ids))
  ipcMain.handle('addBlockedMember', async (_event, userId) => db().addBlockedMember(userId))
  ipcMain.handle('removeBlockedMember', async (_event, userId) => db().removeBlockedMember(userId))
  ipcMain.handle('hasMembers', async () => db().hasMembers())
  ipcMain.handle('getConfig', async (_event, key, defaultValue?: any) => db().getConfig(key, defaultValue))
  ipcMain.handle('setConfig', async (_event, key, value) => db().setConfig(key, value))
  // memberTree 是内存派生数据（不落盘），直接返回内存字段
  ipcMain.handle('getMemberTree', async () => db().memberTree)
}
