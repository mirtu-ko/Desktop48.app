import { is } from '@electron-toolkit/utils'
import { error, setVerboseEnabled } from '../common/log'

// 主进程日志门控与崩溃兜底（核心 emit 在 src/common/log.ts，仅 console 输出，不落盘）：
// - 打包后的生产环境 console 不可见；需要看主进程日志请以开发模式运行
// - 未捕获异常/unhandledRejection 兜底：加了 handler 后进程不会因未捕获异常直接崩溃，
//   只记录并继续运行——桌面应用宁可带伤运行也不要闪退丢现场

setVerboseEnabled(is.dev)

process.on('uncaughtException', (err) => {
  error('[logger] uncaughtException:', err)
})

process.on('unhandledRejection', (reason) => {
  error('[logger] unhandledRejection:', reason)
})

export { debug, error, isVerboseEnabled, log, warn } from '../common/log'
