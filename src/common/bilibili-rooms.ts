/**
 * 公演团体 → B 站官方直播间号（主进程与渲染层共用）。
 * 房间号人工确认后写死；个人直播无对应房间。
 */
/** 五个团体的 B 站官方直播间号 */
export const GROUP_ROOMS: Record<string, number> = {
  SNH48: 63727,
  BEJ48: 383045,
  GNZ48: 391199,
  CKG48: 6015846,
  CGT48: 27848865,
}

/** B 站房间信息（get_info 归一片段，标题兜底匹配用） */
export interface BilibiliRoomInfo {
  roomId: number
  /** 直播间标题；开播时官方会改为当前公演名 */
  title: string
  /** 0=未开播 1=开播 2=轮播 */
  liveStatus: number
}
