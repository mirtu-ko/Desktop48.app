/**
 * 口袋48主进程能力对外入口（barrel）。
 *
 * 原先这里是 1600 多行的「登录 + 凭证 + 所有业务接口」大文件，现按职责拆成 5 个模块：
 *
 * - `pocket-auth-core.ts`      凭证状态、客户端身份头、HTTP 请求与登录态读接口（底座）
 * - `pocket-auth-session.ts`   登录 / 退出 / 失效、登录有效性校验、每日签到
 * - `pocket-social-api.ts`     关注列表读写、直播聊天室 id、直播复盘
 * - `pocket-room-api.ts`       房间频道解析、发言权限、频道名、小房间暗号、消息流
 * - `pocket-im.ts`             网易云信 IM 凭据、房间发言者资料、删除自己发的房间消息
 *
 * 依赖方向是单向的：业务模块 → core，core 不反向依赖业务模块（会话缓存清理通过
 * `onSessionReset` 钩子登记，见 pocket-auth-core.ts）。`pocket-im.ts` 位于底座之上，
 * `pocket-auth-session.ts` 的 verifyLogin 依赖它，二者之间没有环。
 *
 * **消费方一律从这里 import**：测试里的 `vi.mock('.../pocket-auth')` 依赖这个路径，
 * 把调用方改成直接引用新文件会让 mock 静默失效。新模块导出后请在这里补一行 re-export。
 *
 * 只导出业务侧真正用得到的能力：凭证单例 `credentials`、请求原语 `postPocket`、
 * 会话复位钩子 `onSessionReset` 与 `throwAuthExpired` 属于模块间协作细节，
 * 由各业务模块直接引用 pocket-auth-core，不经这里外泄（避免从外部改到共享状态）。
 */

// ===== 底座：凭证状态 / 身份头 / 请求 / 登录态 =====
export {
  ensureAuthLoaded,
  expireStoredAuth,
  getAuthState,
  getToken,
  logout,
  pocketAppHeaders,
  setAuthExpiredNotifier,
} from './pocket-auth-core'
export type {
  PocketAuthState,
  PocketSmsResult,
  PocketUserInfo,
} from './pocket-auth-core'

// ===== 登录会话 =====
export {
  checkIn,
  loginByCode,
  loginByToken,
  sendSms,
  verifyLogin,
} from './pocket-auth-session'
export type {
  PocketCheckInResult,
  PocketVerifyResult,
} from './pocket-auth-session'

// ===== 网易云信 IM =====
export {
  deleteRoomMessage,
  getImCredentials,
  getRoomSenderProfile,
  IM_APP_KEY,
  resetRoomSenderProfile,
} from './pocket-im'
export type {
  PocketImCredentials,
  PocketRoomSenderProfile,
} from './pocket-im'

// ===== 房间 =====
export {
  checkRoomAnswer,
  getRoomChannel,
  getRoomChannelOwner,
  getRoomEssenceMessages,
  getRoomLastMessages,
  getRoomMessages,
  getRoomPermissions,
  getRoomQuestion,
  getServerChannels,
  MASTER_PASSCODE,
} from './pocket-room-api'

export type {
  PocketRoomAnswerResult,
  PocketRoomChannel,
  PocketRoomLastMessage,
  PocketRoomMessage,
  PocketRoomMessages,
  PocketRoomOwnerInfo,
  PocketRoomPermission,
  PocketRoomQuestion,
  PocketServerChannel,
  RoomMessageScope,
} from './pocket-room-api'

// ===== 关注 / 直播 =====
export {
  followMember,
  getChatroomId,
  getFollowedIds,
  getLiveResult,
  unfollowMember,
} from './pocket-social-api'
