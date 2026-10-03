/**
 * 单条直播弹幕（协议产出 → IPC 下发）。
 * 落 common 而非 main：preload 契约会被渲染层加载，类型留 main 会把 node:buffer 拖进 web 项目。
 */
export interface LiveDanmaku {
  text: string
  username: string
}
