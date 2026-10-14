/**
 * 公演团体 → B 站官方直播间映射（主进程与渲染层共用）。
 *
 * 房间号人工确认后写死：B 站直播搜索接口对匿名返回风控 HTML，没有可用的搜索发现途径；
 * 但房间信息接口（get_info）匿名可访问，主进程用它做运行时标题兜底匹配（main/bilibili/room-info.ts）。
 * 只服务公演，个人直播没有对应房间。
 */
/** 五个团体的 B 站官方直播间号 */
export const GROUP_ROOMS: Record<string, number> = {
  SNH48: 63727,
  BEJ48: 383045,
  GNZ48: 391199,
  CKG48: 6015846,
  CGT48: 27848865,
}

/** B 站房间信息（get_info 的归一片段，标题匹配兜底用） */
export interface BilibiliRoomInfo {
  roomId: number
  /** 直播间标题（开播时官方会改成当前公演名，如「SNH48 《心的旅程》新生公演」） */
  title: string
  /** 0=未开播 1=开播 2=轮播中 */
  liveStatus: number
}
