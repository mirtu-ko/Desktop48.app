/**
 * 单条直播弹幕（协议产出 → IPC 下发）。
 * 落 common 而非 main：preload 契约会被渲染层加载，类型留 main 会把 node:buffer 拖进 web 项目。
 */

/** 单个表情：图片地址与原始尺寸（B 站下发值，px） */
export interface DanmakuEmote {
  url: string
  width: number
  height: number
}

/** 表情名 → 表情图。键即弹幕文本里的占位符，形如 "[热]" */
export type DanmakuEmoteMap = Record<string, DanmakuEmote>

export interface LiveDanmaku {
  text: string
  username: string
  /** 本条弹幕用到的表情；没有表情时缺省 */
  emots?: DanmakuEmoteMap
}

/**
 * 口袋直播弹幕的发送长度上限：主进程校验与输入框 maxlength 同源，
 * 避免两处各写一个数字后输入框允许、发送被拒。
 */
export const POCKET_DANMAKU_MAX_LENGTH = 100
