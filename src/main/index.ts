import { app } from 'electron'

if (process.platform === 'linux') {
  // Wayland 原生支持（有 WAYLAND_DISPLAY 时走 Wayland，否则回落 X11），避免分数缩放模糊
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
  // Ubuntu 24.04+ 默认限制非特权用户命名空间，FUSE 挂载的 AppImage 无法使用 SUID sandbox
  if (process.env.APPIMAGE)
    app.commandLine.appendSwitch('no-sandbox')
}

// 先完成单实例检查，再加载 app.ts：ESM 下静态 import 的副作用先于宿主模块体执行，
// 故用动态 import 把加载推迟到取锁之后。
if (app.requestSingleInstanceLock()) {
  void import('./app')
}
else {
  // 用 exit 而非 quit：quit 是异步的，期间后续代码仍会执行
  app.exit(0)
}
