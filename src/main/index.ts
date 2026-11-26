import { app } from 'electron'

// 先完成单实例检查，再加载 app.ts：ESM 下静态 import 的副作用先于宿主模块体执行，
// 故用动态 import 把加载推迟到取锁之后。
if (app.requestSingleInstanceLock()) {
  void import('./app')
}
else {
  // 用 exit 而非 quit：quit 是异步的，期间后续代码仍会执行
  app.exit(0)
}
