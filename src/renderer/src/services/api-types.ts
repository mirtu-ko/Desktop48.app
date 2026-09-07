/**
 * API 响应模型：
 * 所有在用接口的 content 结构在这里建模，apis.ts 的方法签名与各消费组件
 * 共同引用本文件——上游字段变更从此在编译期暴露，而不是运行时 undefined。
 *
 * 建模依据：代码中的实际字段访问 + database.json 真实数据（syncInfo）。
 * 宽容原则：只用到的字段才声明为必需，其余保持可选，避免过度承诺。
 */

/** ===== 接口信封（request 解析层使用，不直接暴露给消费方） ===== */
export interface ApiEnvelope<T> {
  success?: boolean
  message?: string
  content?: T
}

/** ===== 同步成员信息（UPDATE_INFO_URL，落库即 database.json 的原始结构） ===== */

export interface StarInfoItem {
  userId: number
  realName?: string
  groupId?: number
  groupName?: string
  teamId?: number
  teamName?: string
  /** 0=未出道 1=在团 2=暂休 3=已退团 */
  status?: number
  [key: string]: unknown
}

export interface TeamInfoItem {
  teamId: number
  groupId?: number
  teamName?: string
  teamColor?: string
  teamSort?: number
  /** 队伍徽章（可能是相对路径，渲染端负责归一化） */
  seineTeamBadge?: string
  status?: number
  [key: string]: unknown
}

export interface GroupInfoItem {
  groupId: number
  groupName?: string
  groupSort?: number
  status?: number
  [key: string]: unknown
}

export interface SyncInfoContent {
  starInfo: StarInfoItem[]
  teamInfo: TeamInfoItem[]
  groupInfo: GroupInfoItem[]
}

/** ===== 直播 / 回放列表（LIVE_LIST_URL，翻页游标结构） ===== */

export interface LiveUserInfo {
  userId: string
  nickname: string
  teamLogo?: string
}

export interface LiveListItem {
  liveId: string
  coverPath: string
  /** 开播/开播时间戳（毫秒字符串，parseInt 取值） */
  ctime: string
  userInfo: LiveUserInfo
  title?: string
  /** 1=视频直播 2=电台 */
  liveType?: number
  /** 0=直播 1=录屏 */
  liveMode?: number
  [key: string]: unknown
}

export interface LiveListContent<T = LiveListItem> {
  next: string
  liveList: T[]
}

/** ===== 直播 / 回放详情（LIVE_ONE_URL） ===== */

export interface LiveCarousels {
  carousels: string[]
  carouselTime?: number | string
}

export interface LiveDetailUser {
  userName: string
  userAvatar: string
}

export interface LiveDetail {
  playStreamPath: string
  coverPath: string
  user: LiveDetailUser
  liveId?: string
  onlineNum?: number
  /** 是否可回放（PlaybackPlayer 用） */
  review?: number | boolean
  /** 1=视频直播 2=电台 */
  liveType?: number
  /** 电台轮播图（liveType !== 1 时接口返回） */
  carousels?: LiveCarousels
  /** 弹幕文件地址（回放） */
  msgFilePath?: string
  [key: string]: unknown
}

/** ===== 开放公演 ===== */

export interface OpenLiveTeam {
  teamId: number
  groupId: number
  teamName: string
  teamColor?: string
}

/** 开放公演列表条目（getOpenLiveList） */
export interface OpenLive {
  liveId: string
  title: string
  subTitle: string
  coverPath: string
  /** 1=未开始 2=进行中 4=已结束 */
  status: number
  /** 开演时间（毫秒时间戳字符串） */
  stime: string
  /** 关联队伍，可能为空数组 */
  teamList?: OpenLiveTeam[]
}

export interface OpenLiveStream {
  streamPath?: string
  /** 2=高清 3=超清（回放 VOD 按 3→2→任意 选取） */
  streamType?: number
}

/** 开放公演详情（getOpenLiveOne） */
export interface OpenLiveDetail {
  liveId?: string
  title?: string
  subTitle?: string
  coverPath?: string
  playStreams?: OpenLiveStream[]
  /** 回放弹幕文件地址 */
  msgFilePath?: string
  [key: string]: unknown
}

/** ===== 音乐专辑（MUSIC_LIST_URL，CDN 静态 JSON） ===== */

/** CDN JSON 中的歌曲条目 */
export interface AlbumSong {
  songs_id: string
  songs_name: string
  /** 时长 m:ss，伴奏曲目可能为 null */
  songs_time: string | null
  url: string | null
}

export interface MusicAlbum {
  sid: string
  title: string
  singer: string
  tag: string
  image: string
  year: string
  /** 发行时间（秒级时间戳） */
  start_time: string
  /** 专辑概念页（event 页），可能为空串 */
  link: string
  /** 购买链接（shop 商品页），可能为空串 */
  href: string
  song: AlbumSong[]
}
