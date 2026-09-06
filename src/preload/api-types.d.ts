/**
 * preload API 契约的单一来源：
 * - `index.ts` 用 `satisfies mainAPI` 在编译期校验实现与契约一致（新增/改名通道漏改会直接 typecheck 报错）
 * - `index.d.ts` 从这里取类型，通过 `declare global` 暴露给渲染进程的 `window.mainAPI`
 * 修改任何通道签名时，只需改这里一处，两侧自动受检
 *
 * 返回值类型以主进程各 handler 的真实返回为准：
 * 成员数据见 main/data.ts，任务快照见 main/ffmpeg/task-registry.ts，
 * 成员树见 main/domain/member-tree.ts（buildMemberTree）。
 */
import type { MemberDataContent, StarInfoItem } from '../main/data'
import type { TaskSnapshot } from '../main/ffmpeg/task-registry'

// 类型随契约一起暴露（preload/index.ts 实现侧引用）
export type { MemberDataContent }

// 网络请求参数类型（对端：main/app.ts 的 'netRequest'；body 为序列化后的字符串）
export interface NetRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

// 最小化 electronAPI 类型（替代 @electron-toolkit/preload）
export interface electronAPI {
  process: {
    platform: string
    versions: {
      electron: string
      chrome: string
      node: string
    }
  }
}

// 与 renderer composables/use-blocked-members.ts 的 BlockedMember 同构（跨进程镜像）
export interface BlockedMember {
  userId: number
  realName: string
  teamColor: string
  [key: string]: unknown
}

/** getMemberInfo 返回：成员原始字段 + 主进程派生的队伍色（teamColorOf，成员不在库时为 undefined） */
export type MemberInfo = StarInfoItem & { teamColor: string }

/** createLiveStream 返回：本地 HTTP-FLV 播放地址（对端：main/stream.ts） */
export interface LiveStreamSession {
  url: string
  liveId: string
}

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
  teams: Array<{ teamName: string, label: string, value: string }>
  children: MemberTreeTeamPayload[]
}

// 主 API 类型定义
export interface mainAPI {
  // 网络（返回 utf-8 响应体字符串，由渲染端自行解析 JSON）
  netRequest: (options: NetRequestOptions) => Promise<string>

  // 团队与分组
  saveMemberData: (content: Partial<MemberDataContent>) => Promise<{ ok: true }>
  hasMembers: () => Promise<boolean>

  // 成员与屏蔽名单（对端：main/ipc/register-database-ipc.ts）
  getMemberInfo: (userId: number) => Promise<MemberInfo | undefined>
  getMemberTree: () => Promise<MemberTreeGroupPayload[]>
  getBlockedMembers: () => Promise<BlockedMember[]>
  setBlockedMembers: (ids: number[]) => Promise<void>
  addBlockedMember: (userId: number) => Promise<void>
  removeBlockedMember: (userId: number) => Promise<void>

  // 配置（key 取值见 main/database.ts 的 CONFIG_KEYS；值类型由默认值推断）
  getConfig: <T = unknown>(key: string, defaultValue?: T) => Promise<T>
  setConfig: (key: string, value: unknown) => Promise<void>

  // 文件夹目录（对端：main/app.ts）
  openPath: (filePath: string) => Promise<void>
  checkFfmpegBinaries: (dir: string) => Promise<boolean>
  getDesktopPath: () => Promise<string>
  selectDirectory: () => Promise<string | null>
  pathJoin: (...paths: string[]) => Promise<string>

  // 播放（对端：main/stream.ts。createLiveStream 只登记会话，
  // FFmpeg 由 main/http-server.ts 在播放器实际拉流时才 spawn）
  createLiveStream: (rtmpUrl: string, liveId: string) => Promise<LiveStreamSession>
  stopLiveStream: (liveId: string) => Promise<void>

  // 下载（对端：main/ffmpeg/register-ffmpeg-task.ts；Start 返回落盘文件路径）
  downloadTaskStart: (url: string, filename: string, liveId: string) => Promise<string>
  downloadTaskProgress: (callback: (liveId: string, time: string) => void) => () => void
  downloadTaskEnd: (callback: (liveId: string, filePath: string) => void) => () => void
  downloadTaskError: (callback: (liveId: string, error: string) => void) => () => void
  downloadTaskStop: (liveId: string) => void
  downloadTaskList: () => Promise<TaskSnapshot[]>
  downloadTaskRemove: (liveId: string) => Promise<void>
  getPlatform: () => string

  // 录制（通道与下载同构）
  recordTaskStart: (url: string, filename: string, liveId: string) => Promise<string>
  recordTaskProgress: (callback: (liveId: string, time: string) => void) => () => void
  recordTaskEnd: (callback: (liveId: string, filePath: string) => void) => () => void
  recordTaskError: (callback: (liveId: string, error: string) => void) => () => void
  recordTaskStop: (liveId: string) => void
  recordTaskList: () => Promise<TaskSnapshot[]>
  recordTaskRemove: (liveId: string) => Promise<void>

  // 休眠（preventSleep 返回 powerSaveBlocker id）
  preventSleep: () => Promise<number>
  allowSleep: (id: number) => Promise<void>

  // 窗口控制（对端：main/app.ts）
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  windowOnMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
}
