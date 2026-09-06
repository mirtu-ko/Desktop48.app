/**
 * 全部 IPC 通道的唯一注册入口。
 *
 * 新人查「某个通道在哪注册」只需要看这个文件：按域列出所有 register-* 模块，
 * 每个模块头部注释都标明其通道与 preload/index.ts mainAPI 契约的对应关系。
 * 新增通道域时在此追加一行调用，不要在业务模块里散落 ipcMain.handle。
 */
import { registerDatabaseIPC } from './register-database-ipc'
import { registerStreamIPC } from './register-stream-ipc'
import { registerSystemIPC } from './register-system-ipc'
import { registerTaskIPC } from './register-task-ipc'
import { registerWindowIPC } from './register-window-ipc'

export function registerAllIPC(): void {
  registerDatabaseIPC()
  registerWindowIPC()
  registerSystemIPC()
  registerStreamIPC()
  registerTaskIPC()
}
