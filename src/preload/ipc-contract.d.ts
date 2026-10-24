/**
 * preload IPC 契约的单一来源：
 * - `IpcInvokeMap` 同时约束 preload 的通用 `invokeIpc()` 与主进程的通用 `handleTraced()`
 * - `IpcEventMap` 约束渲染层事件订阅；新增/改名通道漏改会直接 typecheck 报错
 * - 文件末尾通过 `declare global` 暴露给渲染进程的 `window.mainAPI`
 * - 分组顺序与 `index.ts` 中的实现保持一致，便于按域对照阅读
 *
 * 返回值类型以主进程各 handler 的真实返回为准：
 * 成员数据见 main/data.ts，任务快照见 main/ffmpeg/task-registry.ts，
 * 成员树见 main/domain/member-tree.ts（buildMemberTree）。
 */
import type { AppConfig, ConfigKey } from '@common/app-config'
import type { LiveDanmaku } from '@common/live-danmaku'
import type { MemberFlag, MemberFlagKind } from '@common/member-flags'
import type { PocketClientProfileId } from '@common/pocket-client-profile'
import type { AllMemberItem, MemberDataContent, OfficialInfoItem, StarAdjunctItem, StarInfoItem } from '../main/data'
import type { FfmpegProblem, FfmpegStatus } from '../main/ffmpeg/ffmpeg-process'
import type { TaskSnapshot } from '../main/ffmpeg/task-registry'
import type { NetDiagnoseItem } from '../main/net-diagnose'

// 网络请求参数（对端：main/ipc/register-system-ipc.ts；body 为序列化后的字符串）
export interface NetRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * 网络请求回包：状态码与响应头必须原样回到渲染层。
 *
 * 主进程不能把非 2xx 统一抛成 Error——跨 IPC 的 reject 只保留 message，
 * 状态码会丢，渲染层就无法区分「429 该停」与「502 该重试」。
 */
export interface NetResponse {
  status: number
  body: string
  headers: Record<string, string>
}

// 网络诊断结果随契约一起暴露（渲染端设置页诊断列表消费）
export type { NetDiagnoseItem }

// ===== 成员与屏蔽名单 =====

// 类型随契约一起暴露（preload/index.ts 实现侧与渲染端合并函数引用）
export type { AllMemberItem, MemberDataContent, OfficialInfoItem, StarAdjunctItem }

// 类型随契约一起暴露（preload/index.ts 实现侧与渲染端引用）
export type { MemberFlag, MemberFlagKind }
// 客户端身份档位（口袋48 / 塞纳河48）：跨进程传递与界面选项共用，来源 common
export type { PocketClientProfileId }
export type MemberInfo = StarInfoItem & { teamColor: string }

/**
 * getMemberTree 返回的成员树载荷（团体 → 队伍 → 成员叶子）。
 * 叶子节点是 starInfo 全量字段的 spread，字段由渲染端按需声明
 * （如 Members.vue 的 MemberDetail），故保留任意字段索引。
 */
export interface MemberTreeLeafNode {
  label: string
  value: string
  [key: string]: any
}

/** 队伍节点 */
export interface MemberTreeTeamPayload {
  teamName: string
  label: string
  value: string
  /** 队伍徽章（可能是相对路径，展示前需归一化） */
  teamBadge: string
  children: MemberTreeLeafNode[]
}

/** 团体节点（树的根层） */
export interface MemberTreeGroupPayload {
  groupName: string
  groupId: number | string | undefined
  label: string
  value: string
  children: MemberTreeTeamPayload[]
}

/**
 * getAllMembers 返回：h5.48.cn 落库的 allmembers 成员名单 + 兼职成员档案 + 官方账号
 * （见 main/data.ts 对应类型）。
 */
export interface AllMembersPayload {
  allmembers: AllMemberItem[]
  /** starAdjunctInfo 兼职成员档案（status===1 为有效兼任，渲染端据此归入兼任队伍） */
  adjuncts?: StarAdjunctItem[]
  /**
   * officialInfo 官方账号（袋王 / 各团官方号）：字段与成员记录同构但不是成员，
   * 不在 starInfo 里。房间左列按 userId 反查官方频道（用户可能关注官方号）时用它取名与头像。
   */
  officials?: OfficialInfoItem[]
}

// ===== FFmpeg 下载 =====

/**
 * ffmpegDownloadProgress 事件载荷（对端：main/ffmpeg/ffmpeg-download.ts）。
 * 定义在契约文件而非主进程模块：避免 web 类型程序经此引用拉入主进程文件
 * （主进程的 process 用法与 env.d.ts 的渲染层轻量 process 声明冲突）
 */
export interface FfmpegDownloadProgress {
  /** 已接收（gzip 压缩）字节数 */
  received: number
  /** 总字节数；服务器未返回 Content-Length 时为 0（渲染端退化为按 MB 展示） */
  total: number
}

// ===== 房间相册批量下载 =====

/** 一张待下载图片；尺寸来自消息体，0 / 缺省表示未知（主进程下载后识别） */
export interface RoomAlbumDownloadSource {
  url: string
  width?: number
  height?: number
  /** 消息时间（ms），用于生成可读文件名 */
  msgTime?: number
  /** 发送者昵称，用于生成可读文件名 */
  nickname?: string
}

/** 逐张处理进度（对端：main/pocket48/room-album-download.ts） */
export interface RoomAlbumDownloadProgress {
  processed: number
  total: number
  downloaded: number
  skipped: number
  failed: number
}

/** 批量下载结果；canceled=true 表示用户在目录选择器里取消了保存 */
export interface RoomAlbumDownloadResult {
  canceled: boolean
  directory: string
  downloaded: number
  skipped: number
  failed: number
}

// ===== 播放 =====

/** createLiveStream 返回：本地 HTTP-FLV 播放地址（对端：main/stream.ts） */
export interface LiveStreamSession {
  url: string
  liveId: string
}

/** 一批弹幕（对端：main/bilibili/danmaku-session.ts，攒批后按订阅者下发） */
export interface DanmakuBatch {
  /** 渲染层传入的房间号，多房间订阅时据此过滤 */
  roomId: number
  items: LiveDanmaku[]
}

// ===== 独立播放窗口 =====

/** 独立播放窗类型：live=直播，playback=回放（对端：main/float-window.ts） */
export type FloatPlayerKind = 'live' | 'playback'

/**
 * 独立播放窗载荷：渲染端组装（stores/float-players.ts），主进程窗口管理器持有，
 * 播放窗渲染进程再经 floatPlayerGetPayload 回取。必须可结构化克隆。
 */
export interface FloatPlayerPayload {
  liveId: string
  /** 主播名称：有值时标题栏展示为 nickname + title */
  nickname?: string
  /** 播放器头部标题 */
  title: string
  startTime: number
  /** 1=视频直播 2=电台 */
  liveType?: number
  /** 0=直播 1=录屏 */
  liveMode?: number
  /** 数据源：user=用户直播(getLiveOne)，open=开放公演(getOpenLiveOne) */
  source?: string
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatar?: string
  /** 该公演在 B 站的直播间号（真实号；短号也接受）。渲染端按团体映射，个人直播缺省 */
  bilibiliRoomId?: number
}

// ===== 应用更新 =====

/**
 * 自动更新状态（对端：main/updater.ts）。
 *
 * 用可辨识联合而非多个布尔字段：各状态互斥，布尔组合会产生 2^n 种非法状态，
 * 渲染端只能靠约定断言。`phase` 即判别键，可安全 switch / if 收窄。
 *
 * 定义在契约文件而非主进程模块：避免 web 类型程序经此引用拉入主进程文件
 * （与 FfmpegDownloadProgress 同理）。
 */
export type UpdaterState
  /** 尚未检查 */
  = | { phase: 'idle' }
  /** 正在检查（首次检查可能持续数秒） */
    | { phase: 'checking' }
  /** 检查完成且当前没有可用更新 */
    | { phase: 'up-to-date' }
  /** 发现新版本；manualUpdate 表示仅可引导到 GitHub 手动下载 */
    | { phase: 'available', version: string, releaseNotes: string, manualUpdate?: boolean, url?: string }
  /** 正在下载 */
    | { phase: 'downloading', version: string, percent: number, bytesPerSecond: number, transferred: number, total: number }
  /** 已下载完成，等待重启安装 */
    | { phase: 'ready', version: string }
  /** 检查 / 下载失败（国内访问 GitHub 不稳定属常态，非致命） */
    | { phase: 'error', message: string }
  /** 当前环境不支持自动更新（dev 环境 / 免安装版）；url 非空时可引导手工下载 */
    | { phase: 'unsupported', reason: string, url?: string }

// ===== 口袋48账号 =====

/** 口袋48登录态（不含 token 本体；token 只留在主进程） */
export interface PocketAuthState {
  loggedIn: boolean
  nickname: string
  avatar: string
  /** 口袋 userId（登录时落盘）；房间页据此判定「自己发的消息」（删除入口只对自己的展示） */
  userId: string
  /** 脱敏手机号（139****1234）；空串表示未记住 */
  mobileMasked: string
  /** 当前登录身份档位（模拟的官方客户端）；未登录时为默认档 */
  clientProfile: PocketClientProfileId
  /** true = 平台无安全加密能力，token 以明文落盘（仅提示用） */
  plainFallback: boolean
  /** 凭证保存时间（ms 时间戳）；0 = 无记录，供设置页展示「已保存 N 天」 */
  savedAt: number
}

/** 发送验证码结果：needCaptcha=true 时携带反爬问答题 */
export interface PocketSmsResult {
  needCaptcha: boolean
  question: string
  options: string[]
  message: string
}

/** 登录有效性验证结果：imOk 表示弹幕实际依赖的 IM 凭据链路是否可用 */
export interface PocketVerifyResult {
  valid: boolean
  nickname: string
  userId: string
  level: string
  imOk: boolean
  imAccid: string
  /** 鸡腿余额；moneyOk=false 时三个余额无意义（接口失败不影响登录态判定） */
  moneyOk: boolean
  moneyPay: number
  moneyFree: number
  moneyTotal: number
  /** 鸡翅数量（成长值）；user/info/reload 的 support 字段 */
  support: string
  /** 社交资料：服务端不返回的字段为空串，UI 据此隐藏对应条目 */
  fans: string
  likes: string
  signature: string
  message: string
}

/** 每日签到奖励（POST /user/api/v1/checkin） */
export interface PocketCheckInResult {
  addExp: number
  addMoney: number
  addSupport: number
  days: number
}

/** 成员的房间频道（team server + channel）：口袋 App「房间」留言流的订阅目标 */
export interface PocketRoomChannel {
  serverId: string
  channelId: string
}

/**
 * 房间发言权限（room/info 的 userFunction，服务端按当前账号算好）。
 * sendText=false 即该房间禁止发言（房主房间级禁言或个人禁言），渲染层据此禁用输入框。
 */
export interface PocketRoomPermission {
  sendText: boolean
  /** 房间级发言冷却（秒）：禁言房间实测 30，常规房间 10 */
  cdTime: number
  /** 房间身份："0" = 普通成员 */
  roomRole: string
  /** 是否已关注该房间所属成员 */
  followFlag: boolean
}

/** team server 下的频道（seine 频道详情）：channelId + 服务端给的频道名 */
export interface PocketServerChannel {
  channelId: string
  channelName: string
}

/** 小房间（暗号频道）的暗号问题（room/info 拦截信封解析结果） */
export interface PocketRoomQuestion {
  questionId: string
  question: string
}

/** 暗号提交结果（主进程对端：pocket-auth.checkRoomAnswer） */
export interface PocketRoomAnswerResult {
  ok: boolean
  /** ok 时：master = 万能密码客户端直通，server = 服务端校验通过 */
  via?: 'master' | 'server'
  /**
   * !ok 时：wrong = 服务端明确判错（含未取到题面），unverified = 校验接口不可达。
   * 校验走 `im/api/v1/team/channel/question/answer/verify`（实测见
   * pocket-auth.checkRoomAnswer）；两种情况渲染层一律视为未通过（不放行），
   * 由 message 说明原因。
   */
  reason?: 'wrong' | 'unverified'
  message?: string
}

/** 单条房间消息（CustomMessageV2）：正文 bodys 多为 JSON 字符串，发送者资料在 extInfo.user */
export interface PocketRoomMessage {
  msgIdServer: string
  msgIdClient: string
  msgType: string
  msgTime: number
  bodys: string
  extInfo: string
}

export interface PocketRoomMessages {
  messages: PocketRoomMessage[]
  /** 更早历史的游标（接口返回；0 = 没有更多） */
  nextTime: number
}

/** 频道最后一条消息（左侧房间列表预览；msgContent 与房间消息 bodys 同构） */
export interface PocketRoomLastMessage {
  channelId: string
  starName: string
  msgContent: string
  msgTime: number
  /** 服务端真实未读数；null = pa 降级回包没给该字段 */
  unreadCount: number | null
}

// ===== 房间消息发送（QChat 圈组长连接） =====

// 对端：main/pocket48/pocket-room-qchat.ts（会话与发送）、nim-qchat.ts（协议解码）。
// 与直播间弹幕（pocketDanmaku*）是两套体系：房间留言走云信圈组，弹幕走云信聊天室。

/** QChat 传输层房间消息（主进程 nim-qchat.ts 解码出的形状；业务归一在渲染层 utils/pocket-room-message.ts） */
export interface PocketRoomQChatMessage {
  serverId: string
  channelId: string
  fromAccount: string
  fromClientType: number
  fromNick: string
  time: number
  /** 0 = 文本，100 = 自定义（回复等，正文在 attachment） */
  type: number
  body: string
  attachment: string
  ext: string
  msgIdClient: string
  msgIdServer: string
}

export type PocketRoomQChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** 房间 QChat 事件批次（对端：pocket-room-qchat.ts，发给订阅了该账号房间会话的窗口） */
export type PocketRoomBatch
  = | { kind: 'status', status: PocketRoomQChatStatus, message?: string }
    | { kind: 'message', message: PocketRoomQChatMessage }

/** 回复态入参：被回复消息的摘要（msgIdClient 必填，服务端据此关联原消息） */
export interface PocketRoomReplyTarget {
  msgIdClient: string
  senderName: string
  text: string
  giftInfo?: Record<string, unknown>
}

/** 进房连接结果：!ok 时 message 说明原因（未登录 / 凭据失效 / 连接失败） */
export interface PocketRoomQChatEnterResult {
  ok: boolean
  message?: string
}

/**
 * 发送结果：服务端 ACK 的消息 ID 与时刻（time 为协议原值，秒/毫秒未归一），
 * 以及一条**发送回显**（ACK 只回 ID 与时刻，正文与资料由发送入参补全）——
 * 渲染层按 24/11 同一形状归一插入，与推送回显、HTTP 回包按 msgIdClient 三源去重。
 */
export interface PocketRoomSendResult {
  msgIdClient: string
  msgIdServer: string
  time: number
  message: PocketRoomQChatMessage
}

/** 口袋48聊天室原始消息（主进程协议客户端解码出的传输层形状；业务归一在渲染层 utils/pocket-chat-message.ts） */
export interface PocketRawChatMessage {
  uuid: string
  /** 传输层类型：0=文本，其余为自定义消息 */
  type: 'text' | 'custom'
  msgType: number
  /** 附件 / 正文（文本消息即正文） */
  attach: string
  /** 业务扩展 JSON 字符串（messageType / user / giftInfo 等都在里面） */
  custom: string
  /** 正文（文本消息取 attach，自定义消息取扩展文本属性） */
  text: string
  fromNick: string
  fromAvatar: string
  from: string
  time: number
}

export type PocketDanmakuStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** 口袋聊天室事件批次（对端：main/pocket48/pocket-danmaku.ts，仅发给订阅了该聊天室的窗口） */
export interface PocketDanmakuBatch {
  /** 渲染层传入的聊天室 ID，多会话订阅时据此过滤 */
  chatroomId: string
  kind: 'status' | 'messages'
  status?: PocketDanmakuStatus
  message?: string
  items?: PocketRawChatMessage[]
}

// ===== 房间未读 =====

// 对端：main/pocket48/pocket-unread.ts。检测与未读状态归主进程（唯一真相），
// 渲染层 stores/pocket-unread.ts 只做镜像，变化经 pocketUnreadBatch 全量广播。

/** 单个房间的未读快照（userId 为键；count>0 的房间才会出现） */
export interface PocketUnreadRoomState {
  /** 未读条数（大房间 + 小房间合计；单频道按消息列表一页封顶 → 角标显示 50+） */
  count: number
  /** 大房间频道的未读贡献（频道切换 tab 的点点） */
  bigCount: number
  /** 小房间（暗号频道）的未读贡献（频道切换 tab 的点点） */
  smallCount: number
  /** 最新一条未读消息时刻（ms） */
  latestTime: number
}
/**
 * 单个频道的已读水位（「读到哪一条」）。
 * 渲染层只用 msgTime 与消息列表比较，定位「以下是新消息」分割线；
 * msgIdServer 是同源取数时的精确定位依据（同一毫秒多条），渲染层不要拿列表里的 id 回写水位。
 */
export interface PocketRoomReadMark {
  msgTime: number
  msgIdServer: string
}
/** 未读全量快照 */
export interface PocketUnreadBatch {
  rooms: Record<string, PocketUnreadRoomState>
  /** 全部房间未读总数（Dock tab / 任务栏角标用） */
  total: number
}

// ===== 类型化 IPC 通道映射 =====

interface InvokeSpec<Args extends readonly unknown[], Return> {
  args: Args
  return: Return
}

/**
 * 通用任务通道前缀；具体通道由
 * `${prefix}Start|List|Remove|Started|Progress|End|Error` 组成。
 */
export type TaskChannelPrefix = 'downloadTask' | 'recordTask'

// 类型随契约一起暴露：preload 的事件订阅签名与渲染端 stores/tasks.ts 都要用它
export type { TaskSnapshot }
// FFmpeg 环境状态与原因枚举随契约暴露：渲染层的启动门禁/设置页/下载前校验共用同一判定结果
export type { FfmpegProblem, FfmpegStatus }

interface StaticIpcInvokeMap {
  netRequest: InvokeSpec<[options: NetRequestOptions], NetResponse>
  /** 网络诊断：对核心服务域名逐一发轻量 GET，返回状态码/耗时/失败原因（对端：main/net-diagnose.ts） */
  netDiagnose: InvokeSpec<[], NetDiagnoseItem[]>
  saveMemberData: InvokeSpec<[content: Partial<MemberDataContent>], { ok: true }>
  getAllMembers: InvokeSpec<[], AllMembersPayload>
  hasMembers: InvokeSpec<[], boolean>
  getMemberInfo: InvokeSpec<[userId: number], MemberInfo | undefined>
  getMemberTree: InvokeSpec<[], MemberTreeGroupPayload[]>
  getMemberFlags: InvokeSpec<[kind: MemberFlagKind], MemberFlag[]>
  setMemberFlags: InvokeSpec<[kind: MemberFlagKind, ids: Array<number | string>], void>
  addMemberFlag: InvokeSpec<[kind: MemberFlagKind, userId: number], void>
  /** 批量幂等合并（口袋关注同步）：整批一次读改写 */
  addMemberFlags: InvokeSpec<[kind: MemberFlagKind, userIds: number[]], void>
  removeMemberFlag: InvokeSpec<[kind: MemberFlagKind, userId: number], void>
  getConfig: InvokeSpec<[key: ConfigKey], string>
  setConfig: InvokeSpec<[key: ConfigKey, value: string], void>
  openPath: InvokeSpec<[filePath: string], void>
  selectDirectory: InvokeSpec<[], string | null>
  pathJoin: InvokeSpec<[...paths: string[]], string>
  /** 打开一次目录选择器，随后把相册图片逐张写入所选目录（对端：main/pocket48/room-album-download.ts） */
  roomAlbumDownload: InvokeSpec<[sources: RoomAlbumDownloadSource[], filterSmall: boolean], RoomAlbumDownloadResult>
  /** FFmpeg 环境状态：省略 dir 时校验当前生效配置，传入时校验指定目录（选择/下载后的即时校验） */
  getFfmpegStatus: InvokeSpec<[dir?: string], FfmpegStatus>
  downloadFfmpeg: InvokeSpec<[], string>
  createLiveStream: InvokeSpec<[rtmpUrl: string, liveId: string], LiveStreamSession>
  stopLiveStream: InvokeSpec<[liveId: string], void>
  /** 返回 false 表示握手失败（房间号取不到 / WBI 被拒 / 网络异常），渲染层据此提示一次 */
  danmakuStart: InvokeSpec<[roomId: number], boolean>
  danmakuStop: InvokeSpec<[roomId: number], void>
  openFloatWindow: InvokeSpec<[kind: FloatPlayerKind, payload: FloatPlayerPayload], void>
  floatPlayerGetPayload: InvokeSpec<[kind: FloatPlayerKind, liveId: string], FloatPlayerPayload | null>
  floatWindowFitAspect: InvokeSpec<[aspect: number], void>
  floatWindowSetPlaying: InvokeSpec<[playing: boolean], void>
  notifyLiveUnavailable: InvokeSpec<[liveId: string], void>
  windowMinimize: InvokeSpec<[], void>
  windowToggleMaximize: InvokeSpec<[], void>
  windowClose: InvokeSpec<[], void>
  windowIsMaximized: InvokeSpec<[], boolean>
  preventSleep: InvokeSpec<[], number>
  allowSleep: InvokeSpec<[id: number], void>
  /** 当前应用版本号（如 "0.1.9"），设置页展示用 */
  getAppVersion: InvokeSpec<[], string>
  /** 取当前更新状态（渲染端挂载时回取一次快照；后续变化走 updaterState 事件） */
  updaterGetState: InvokeSpec<[], UpdaterState>
  /** 手动检查更新；返回检查后的状态（失败已折进状态，调用方无需 try/catch） */
  updaterCheck: InvokeSpec<[], UpdaterState>
  /** 用户确认后开始下载新版本 */
  updaterDownload: InvokeSpec<[], void>
  /** 退出并安装已下载的更新 */
  updaterInstall: InvokeSpec<[], void>

  // ===== 口袋48账号 =====
  // 对端：main/ipc/register-pocket-ipc.ts；登录与凭证存储在 main/pocket48/pocket-auth.ts
  /** 发送登录验证码；命中反爬问答题时返回 needCaptcha=true 与题目选项 */
  pocketSendSms: InvokeSpec<[mobile: string, area?: string, answer?: string, clientProfile?: PocketClientProfileId], PocketSmsResult>
  /** 验证码登录；clientProfile 为本轮选定的身份档位，随凭证保存；失败以 reject 报错 */
  pocketLoginByCode: InvokeSpec<[mobile: string, code: string, area?: string, clientProfile?: PocketClientProfileId], PocketAuthState>
  /** 粘贴 token 登录：主进程校验有效后落盘；无效以 reject 报错 */
  pocketLoginByToken: InvokeSpec<[token: string, mobile?: string, clientProfile?: PocketClientProfileId], PocketAuthState>
  /** 当前登录态（读本地凭证，不做网络校验） */
  pocketGetAuthState: InvokeSpec<[], PocketAuthState>
  /** 退出登录：删除本地凭证 */
  pocketLogout: InvokeSpec<[], void>
  /** 取直播的聊天室 id（需登录，无 token 的详情接口拿不到）；未登录返回空串，过期 reject */
  pocketGetChatroomId: InvokeSpec<[liveId: string], string>
  /**
   * 拉直播结束复盘（live/result，需登录）：总观看 / 本场时长 / 礼物流水 / 榜单前三，
   * 原样回传上游 content（字段是字符串数字，宽松解析归渲染层 live-result.ts）；
   * 未登录 / 接口失败 reject，调用方降级简版结束卡
   */
  pocketGetLiveResult: InvokeSpec<[liveId: string], Record<string, unknown>>
  /** 验证登录有效性：真实请求 token 校验与 IM 凭据两个需登录接口 */
  pocketVerifyLogin: InvokeSpec<[], PocketVerifyResult>
  /** 每日签到；重复签到 / 网络异常等失败以 reject 报错 */
  pocketCheckIn: InvokeSpec<[], PocketCheckInResult>
  /** 拉取账号关注成员 ID 列表（只给 ID，详情由本地成员树解析）；未登录空数组，过期 reject */
  pocketGetFollowedIds: InvokeSpec<[], number[]>
  /** 关注成员（桌面端 toggle 双写）；失败 reject，调用方静默降级 */
  pocketFollowMember: InvokeSpec<[userId: number], void>
  /** 取消关注成员（桌面端 toggle 双写）；失败 reject，调用方静默降级 */
  pocketUnfollowMember: InvokeSpec<[userId: number], void>
  /** 解析成员的房间频道（口袋 App「房间」留言流用，非直播间弹幕）；未登录返回空频道，过期 reject */
  pocketGetRoomChannel: InvokeSpec<[userId: number], PocketRoomChannel>
  /**
   * 拉取当前账号在房间的发言权限（room/info 的 userFunction）：sendText=false = 禁止发言。
   * 未登录返回 null；小房间暗号未通过（status 2001）等失败 reject，调用方按「未知」处理。
   */
  pocketGetRoomPermissions: InvokeSpec<[channelId: string], PocketRoomPermission | null>
  /** 拉取房间频道消息（msgTime 倒序最新在前；nextTime 为更早历史游标，轮询传 0 拉最新） */
  pocketGetRoomMessages: InvokeSpec<[channelId: string, serverId: string, nextTime?: number, scope?: 'member' | 'all'], PocketRoomMessages>
  /** 拉取房间精华消息（房主/管理员置顶的那批；与消息范围无关，nextTime 0 = 没有更多） */
  pocketGetRoomEssenceMessages: InvokeSpec<[channelId: string, serverId: string, nextTime?: number], PocketRoomMessages>
  /** 批量拉取各 server 频道的最后一条消息（左侧列表预览） */
  pocketGetRoomLastMessages: InvokeSpec<[serverIds: string[]], PocketRoomLastMessage[]>
  /** 拉取 team server 下全部频道的 id 与名称（房间页 tab 显示真实频道名；失败返回空数组） */
  pocketGetServerChannels: InvokeSpec<[serverId: string], PocketServerChannel[]>
  /** 起口袋聊天室弹幕会话并登记订阅；false = 未登录/凭据失效/参数无效 */
  pocketDanmakuStart: InvokeSpec<[chatroomId: string, liveId: string], boolean>
  /** 退订聊天室弹幕；最后一个订阅者离开时主进程断开连接 */
  pocketDanmakuStop: InvokeSpec<[chatroomId: string], void>
  /** 房间未读全量快照（启动时回取一次；后续变化走 pocketUnreadBatch 事件） */
  pocketUnreadState: InvokeSpec<[], PocketUnreadBatch>
  /** 作废失效的小房间归属（房主更新后旧频道被删）；下一轮检测重新枚举该 server */
  pocketInvalidateSmallChannel: InvokeSpec<[userId: number], void>
  /** 重新发现小房间（枚举 server 频道列表）；force 绕过发现间隔，用于旧频道刚失效 */
  pocketRefreshSmallChannel: InvokeSpec<[userId: number, force?: boolean], PocketRoomChannel | null>
  /** 拉取小房间的暗号问题；null = 无门禁（room/info 未被拦），其余错误 reject */
  pocketGetRoomQuestion: InvokeSpec<[channelId: string], PocketRoomQuestion | null>
  /**
   * 提交小房间暗号：走服务端校验端点，success 才算通过（via=server）；
   * 万能密码为开发者自用通道（via=master，不发起请求）；接口不可达时 reason=unverified。
   */
  pocketCheckRoomAnswer: InvokeSpec<[channelId: string, questionId: string, answer: string], PocketRoomAnswerResult>
  /**
   * 标记房间已读：目标频道未读清零并广播，另一路（大/小房间）未读保留；
   * 主进程随即把该频道的已读水位推到当下，下一轮检测数出的就是读了之后的新消息
   */
  pocketMarkRead: InvokeSpec<[userId: number, target?: 'room' | 'small'], void>
  /**
   * 某频道的已读水位（只读，不推进不广播）：进房画未读分割线用。
   * 必须在 pocketMarkRead 之前取——markRead 会把水位推到当下，之后取就永远没有分割线。
   * 频道未解析（小房间还没被归属发现）或从未锚定时返回 null，调用方退回「只显示未读计数」。
   */
  pocketReadMark: InvokeSpec<[userId: number, target?: 'room' | 'small'], PocketRoomReadMark | null>
  /**
   * 进入房间频道的 QChat 连接（订阅实时消息）。渲染层进房时调用，离房走 Leave；
   * 同一账号多频道复用一条连接，最后一个订阅者离开即断开。
   */
  pocketRoomQChatEnter: InvokeSpec<[serverId: string, channelId: string], PocketRoomQChatEnterResult>
  /** 离开房间频道：退订并（无剩余订阅时）断开连接 */
  pocketRoomQChatLeave: InvokeSpec<[serverId: string, channelId: string], void>
  /**
   * 在房间频道发言（QChat 24/10）。reply 非空时为回复某条消息（custom 类型）；
   * 服务端 ACK 带回 msgIdServer 与时刻。未连接 / 冷却中 / 目标频道未订阅均 reject。
   */
  pocketSendRoomMessage: InvokeSpec<[serverId: string, channelId: string, text: string, reply?: PocketRoomReplyTarget], PocketRoomSendResult>
  /** 删除自己发的房间消息（HTTP im/api/v1/team/msg/delete；服务端按 accId 校验） */
  pocketDeleteRoomMessage: InvokeSpec<[channelId: string, msgIdClient: string, msgTime: number], void>

  // ===== B 站直播间信息 =====
  // 对端：main/bilibili/room-info.ts
  /** 五个团体官方直播间的标题与开播状态（主进程缓存 5 分钟，失败房间以空标题占位） */
  bilibiliRoomInfos: InvokeSpec<[], import('../common/bilibili-rooms').BilibiliRoomInfo[]>
}

type TaskInvokeMap = {
  [K in TaskChannelPrefix as `${K}Start`]: InvokeSpec<[url: string, filename: string, liveId: string], string>
} & {
  [K in TaskChannelPrefix as `${K}List`]: InvokeSpec<[], TaskSnapshot[]>
} & {
  [K in TaskChannelPrefix as `${K}Remove`]: InvokeSpec<[liveId: string], void>
}

export type IpcInvokeMap = StaticIpcInvokeMap & TaskInvokeMap
export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcInvokeArgs<Channel extends IpcInvokeChannel> = IpcInvokeMap[Channel]['args']
export type IpcInvokeReturn<Channel extends IpcInvokeChannel> = IpcInvokeMap[Channel]['return']

/** 渲染层 invoke API：由通道映射派生，避免在 mainAPI 中重复声明参数与返回值。 */
export type IpcInvokeApi = {
  [Channel in IpcInvokeChannel]: (...args: IpcInvokeArgs<Channel>) => Promise<IpcInvokeReturn<Channel>>
}

type TaskEventMap = {
  [K in TaskChannelPrefix as `${K}Progress`]: [liveId: string, time: string]
} & {
  [K in TaskChannelPrefix as `${K}End`]: [liveId: string, filePath: string]
} & {
  [K in TaskChannelPrefix as `${K}Error`]: [liveId: string, error: string]
} & {
  /**
   * 任务已在主进程登记。任务状态由主进程注册表统一持有、每个窗口各存一份镜像，
   * 因此这类事件广播给全部窗口（见 main/ipc/send.ts 的 broadcastIpc）：
   * 在独立播放窗发起的录制 / 下载，主窗口据此把它补进下载页列表。
   *
   * ⚠️ 唯一的例外是**删除类操作没有对应事件、也不广播**
   * （`${prefix}Remove` 是 invoke 通道）。跨窗一致性的前提是「只有一个窗口能发起删除」——
   * 下载页只在主窗口挂载。若将来播放窗也加删除入口，必须先补一个 Removed 广播事件，
   * 否则各窗口的镜像列表会分叉。
   */
  [K in TaskChannelPrefix as `${K}Started`]: [snapshot: TaskSnapshot]
}

export type IpcEventMap = {
  ffmpegDownloadProgress: [progress: FfmpegDownloadProgress]
  /** 相册批量下载逐张进度，仅回推发起窗口 */
  roomAlbumDownloadProgress: [progress: RoomAlbumDownloadProgress]
  windowOnMaximizeChange: [isMaximized: boolean]
  /** 主进程转发：独立播放窗报告某直播已下架，主窗口据此刷新列表（对端：main/float-window.ts） */
  liveUnavailable: [liveId: string]
  /** B 站弹幕攒批下发（对端：main/bilibili/danmaku-session.ts，仅发给订阅了该房间的窗口） */
  danmakuBatch: [batch: DanmakuBatch]
  /** 口袋聊天室事件（对端：main/pocket48/pocket-danmaku.ts，仅发给订阅了该聊天室的窗口） */
  pocketDanmakuBatch: [batch: PocketDanmakuBatch]
  /** 房间 QChat 事件（对端：main/pocket48/pocket-room-qchat.ts：连接状态 + 实时消息，发给订阅了房间会话的窗口） */
  pocketRoomBatch: [batch: PocketRoomBatch]
  /**
   * 房间未读状态变化（对端：main/pocket48/pocket-unread.ts，全量快照）。
   * 未读状态由主进程统一持有、每个窗口各存镜像，因此广播给全部窗口（见 main/ipc/send.ts）。
   */
  pocketUnreadBatch: [state: PocketUnreadBatch]
  /** 登录凭证已因 token 失效被清除（对端：pocket-auth.ts），各窗镜像据此复位 */
  pocketAuthExpired: []
  /**
   * 更新状态变化（对端：main/updater.ts）。
   * 状态归主进程所有、每个窗口各存镜像，因此广播给全部窗口（见 main/ipc/send.ts 的 broadcastIpc）。
   */
  updaterState: [state: UpdaterState]
} & TaskEventMap

export type IpcEventChannel = keyof IpcEventMap
export type IpcEventArgs<Channel extends IpcEventChannel> = IpcEventMap[Channel]

// ===== 主进程 API 契约 =====

/** 事件通道与渲染层订阅 API 同源推导；ffmpeg 进度因方法名带 on 前缀单独声明。 */
type IpcEventSubscriptionApi = {
  [Channel in Exclude<IpcEventChannel, 'ffmpegDownloadProgress'>]: (
    callback: (...args: IpcEventArgs<Channel>) => void,
  ) => () => void
}

export type mainAPI = Omit<IpcInvokeApi, 'getConfig' | 'setConfig'> & IpcEventSubscriptionApi & {
  // ===== 需要保留键关联类型的配置 API =====
  getConfig: <K extends ConfigKey>(key: K) => Promise<AppConfig[K]>
  setConfig: <K extends ConfigKey>(key: K, value: AppConfig[K]) => Promise<void>

  // ===== 非 invoke / 非标准命名的渲染层 API =====
  onFfmpegDownloadProgress: (callback: (progress: FfmpegDownloadProgress) => void) => () => void
  downloadTaskStop: (liveId: string) => void
  recordTaskStop: (liveId: string) => void
}

// 渲染进程全局 Window 声明：类型契约仍以本文件为唯一来源，
// 避免 index.ts（含 Electron 实现细节）进入渲染层类型程序。
declare global {
  interface Window {
    mainAPI: mainAPI
  }
}
