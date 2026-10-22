/**
 * 口袋48 pocketapi 接口地址（唯一来源）。
 *
 * 同一批地址被两个请求层共用：地址相同，但两端的**身份**不同——
 * - 渲染层站点请求：`renderer/src/services/api-urls.ts` → `Request`（移动端浏览器 UA）
 * - 主进程 App 域请求：`main/pocket48/pocket-auth.ts` → `postPocket`（Android 档客户端伪装头 + pa + token）
 *
 * 此前两边各写一份（`getLiveOne` 即为重复项），端点变更需同时改两处；现集中于此。
 * 边界：cgt48.com 的曲库属**其它域名**，留在渲染层 api-urls.ts；B 站链路、网易云信 lbs、
 * 主进程域名白名单（allowed-hosts.ts）各有独立域名体系，不并入本文件。
 * 成员名单（h5.48.cn）虽不在 pocketapi 域，但同步与网络诊断两地共用，一并放这里。
 */

/** pocketapi 统一 origin：域名变更只需改这一处 */
const ORIGIN = 'https://pocketapi.48.cn'

// ===== 直播 / 回放（渲染层 Apis.* 调用；LIVE_ONE_URL 同时被主进程 getChatroomId 使用） =====

export const LIVE_LIST_URL = `${ORIGIN}/live/api/v1/live/getLiveList`
/** 公演排期列表 */
export const OPEN_LIVE_LIST_URL = `${ORIGIN}/live/api/v1/live/getOpenLiveList`
export const OPEN_LIVE_URL = `${ORIGIN}/live/api/v1/live/getOpenLiveOne`
/** 直播详情：仅带 token 的请求才返回 chatroomId（实测无 token 时 roomId 恒 0 且无 chatroomId 字段） */
export const LIVE_ONE_URL = `${ORIGIN}/live/api/v1/live/getLiveOne`

// ===== 成员数据同步（starInfo / teamInfo 等分节的全量拉取） =====

export const UPDATE_INFO_URL = `${ORIGIN}/user/api/v1/client/update/group_team_star`

// ===== 成员名单（h5.48.cn，非 pocketapi 域；同步与网络诊断共用同一组地址） =====

/**
 * 静态快照（主源）：一次 941KB 的全量名单，34 字段与下方 jsonp 接口同构。
 * 接口自 2026-10 起常态 502 时它仍可用，`apis.ts` 的 ALL_MEMBER_SOURCES 以它打头。
 */
export const ALL_MEMBER_SNAPSHOT_URL = 'https://h5.48.cn/resource/json/allmembers_0.jsonp'
/** jsonp 接口（备源）：动态名单，需 App 身份头 */
export const ALL_MEMBER_URL = 'https://h5.48.cn/resource/jsonp/allmembers.php?gid=00'

// ===== 账号 / 登录（主进程 pocket-auth 调用） =====

/** v2 发码：来源 7.1.44 APK `LoginViewModel → api/v2/sms/send_sms` */
export const SMS_SEND_URL = `${ORIGIN}/user/api/v2/sms/send_sms`
/** v2 手机验证码登录：来源 7.1.44 APK Retrofit 接口注解 */
export const SMS_LOGIN_URL = `${ORIGIN}/user/api/v2/login/app/app_login`
export const TOKEN_CHECK_URL = `${ORIGIN}/user/api/v1/user/info/reload`
/** 口袋钱包余额：验证登录态时顺带展示，接口失败不影响登录态判定 */
export const USER_MONEY_URL = `${ORIGIN}/user/api/v1/user/money`
/** 关注成员 ID 列表（账号维度，一次性返回无分页；只给 ID，详情由本地成员树解析） */
export const FRIENDS_IDS_URL = `${ORIGIN}/user/api/v1/friendships/friends/id`
/** 关注 / 取消关注成员（桌面端 toggle 双写用） */
export const FRIEND_ADD_URL = `${ORIGIN}/user/api/v2/friendships/friends/add`
export const FRIEND_REMOVE_URL = `${ORIGIN}/user/api/v2/friendships/friends/remove`

// ===== IM 凭据与成员房间（主进程 pocket-auth 调用） =====

/** 网易云信 IM 凭据（直播聊天室连接用）：需登录 token，额外带 P-Sign-Type 头 */
export const IM_USER_INFO_URL = `${ORIGIN}/im/api/v1/im/userinfo`
/** 成员 userId → 房间频道（team server + channel）解析：starId 即成员 userId */
export const SERVER_JUMP_URL = `${ORIGIN}/im/api/v1/im/server/jump`
export const ROOM_INFO_URL = `${ORIGIN}/im/api/v1/im/team/room/info`
/**
 * 答案校验端点：小房间暗号唯一的真实校验入口，见 checkRoomAnswer 的实测记录。
 * 来源：塞纳河48 客户端（com.seine48.app）jadx 反编译——Retrofit 接口
 * `com.meta.module_base.network.api.ApiIM#questionAnswer`
 * `@POST("im/api/v1/team/channel/question/answer/verify")`，
 * 请求体由 `ChannelSwitchViewModel.submitQuestionAnswer` 构造：`{ answer, questionId }`。
 */
export const ROOM_ANSWER_VERIFY_URL = `${ORIGIN}/im/api/v1/team/channel/question/answer/verify`
/**
 * 频道详情（seine 服务）：给定 team server 返回其下全部频道，含服务端给的 channelName。
 * 房间页「房间 / 小房间」切换要显示真实频道名，而 jump 与 lastMsgList 都不带频道名，
 * 被暗号拦下的 room/info 也拿不到 channelInfo——名称只能从这里取。
 * 参考实现 yaya_msg 同款；seine 有独立的客户端特征，见 seineHeaderOverrides。
 */
export const SEINE_SERVER_DETAIL_URL = `${ORIGIN}/im/api/seine/server/detail`
/**
 * 房间消息列表接口：同一频道两档口径（参考实现 yaya_msg 同款切换）。
 * homeowner 仅房主（成员）发言（会混入官方系统账号 121569667，由渲染层过滤）；
 * all 全员发言。
 */
export const ROOM_MESSAGE_URLS = {
  member: `${ORIGIN}/im/api/v1/team/message/list/homeowner`,
  all: `${ORIGIN}/im/api/v1/team/message/list/all`,
} as const
/** 批量取各 server 下每个频道的最后一条消息（左侧列表预览用；参考实现 yaya_msg 同款） */
export const ROOM_LAST_MESSAGE_URL = `${ORIGIN}/im/api/v1/team/classic/last/message/get`
/**
 * 房间精华消息（口袋 App 房间顶部置顶展示的那批，房主 / 管理员设置）。
 * 回包 `content.essenceMessageList`，元素与普通消息同构（msgId / msgType / bodys / extInfo 一致），
 * 另带 `essenceInfo`（精华设置信息，本版本不消费）。
 * 来源：官方 pocket48 7.1.44 APK 字符串池（端点、`essenceMessageList`、`essenceInfo` 三处同现），
 * 与参考实现 yaya_msg 的请求体一致（`{ channelId, serverId, nextTime, limit }`）。
 */
export const ROOM_ESSENCE_MESSAGE_URL = `${ORIGIN}/im/api/v1/team/essence/message/list`
/**
 * 删除自己发的房间消息（HTTP；房间发言本身走云信 QChat，删除是唯一的 HTTP 写操作）。
 * 服务端按 accId 校验只能删自己的。参考实现 yaya_msg 同款，请求体
 * `{ accId, msgIdClient, channelId, msgTime }`。
 */
export const ROOM_MSG_DELETE_URL = `${ORIGIN}/im/api/v1/team/msg/delete`
