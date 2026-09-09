/**
 * preload IPC 契约的单一来源：
 * - `index.ts` 用 `satisfies mainAPI` 在编译期校验实现与契约一致（新增/改名通道漏改会直接 typecheck 报错）
 * - 文件末尾通过 `declare global` 暴露给渲染进程的 `window.mainAPI`
 * - 分组顺序与 `index.ts` 中的实现保持一致，便于按域对照阅读
 *
 * 返回值类型以主进程各 handler 的真实返回为准：
 * 成员数据见 main/data.ts，任务快照见 main/ffmpeg/task-registry.ts，
 * 成员树见 main/domain/member-tree.ts（buildMemberTree）。
 */
import type { MemberDataContent, StarInfoItem } from '../main/data'
import type { TaskSnapshot } from '../main/ffmpeg/task-registry'

// ===== 基础环境 =====

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

// 网络请求参数（对端：main/ipc/register-system-ipc.ts；body 为序列化后的字符串）
export interface NetRequestOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

// ===== 成员与屏蔽名单 =====

// 类型随契约一起暴露（preload/index.ts 实现侧引用）
export type { MemberDataContent }

// 与 renderer composables/use-blocked-members.ts 的 BlockedMember 同构（跨进程镜像）
export interface BlockedMember {
  userId: number
  realName: string
  teamColor: string
  [key: string]: unknown
}

/** getMemberInfo 返回：成员原始字段 + 主进程派生的队伍色（teamColorOf，成员不在库时为 undefined） */
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
  teams: Array<{ teamName: string, label: string, value: string }>
  children: MemberTreeTeamPayload[]
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

// ===== 播放 =====

/** createLiveStream 返回：本地 HTTP-FLV 播放地址（对端：main/stream.ts） */
export interface LiveStreamSession {
  url: string
  liveId: string
}

// ===== 主进程 API 契约 =====

export interface mainAPI {
  // ===== 运行环境 =====
  getPlatform: () => string

  // ===== 网络请求 =====
  // 返回 utf-8 响应体字符串，由渲染端自行解析 JSON
  netRequest: (options: NetRequestOptions) => Promise<string>

  // ===== 成员与屏蔽名单 =====
  saveMemberData: (content: Partial<MemberDataContent>) => Promise<{ ok: true }>
  hasMembers: () => Promise<boolean>
  getMemberInfo: (userId: number) => Promise<MemberInfo | undefined>
  getMemberTree: () => Promise<MemberTreeGroupPayload[]>
  getBlockedMembers: () => Promise<BlockedMember[]>
  setBlockedMembers: (ids: number[]) => Promise<void>
  addBlockedMember: (userId: number) => Promise<void>
  removeBlockedMember: (userId: number) => Promise<void>

  // ===== 应用配置 =====
  // key 取值见 main/database.ts 的 CONFIG_KEYS；值类型由默认值推断
  getConfig: <T = unknown>(key: string, defaultValue?: T) => Promise<T>
  setConfig: (key: string, value: unknown) => Promise<void>

  // ===== 文件系统与目录 =====
  openPath: (filePath: string) => Promise<void>
  getDesktopPath: () => Promise<string>
  selectDirectory: () => Promise<string | null>
  pathJoin: (...paths: string[]) => Promise<string>

  // ===== FFmpeg 环境 =====
  checkFfmpegBinaries: (dir: string) => Promise<boolean>
  downloadFfmpeg: () => Promise<string>
  onFfmpegDownloadProgress: (callback: (progress: FfmpegDownloadProgress) => void) => () => void

  // ===== 直播播放 =====
  // createLiveStream 只登记会话，FFmpeg 由 main/http-server.ts 在播放器实际拉流时才 spawn
  createLiveStream: (rtmpUrl: string, liveId: string) => Promise<LiveStreamSession>
  stopLiveStream: (liveId: string) => Promise<void>

  // ===== 下载任务 =====
  // 对端：main/ipc/register-task-ipc.ts；Start 返回落盘文件路径
  downloadTaskStart: (url: string, filename: string, liveId: string) => Promise<string>
  downloadTaskProgress: (callback: (liveId: string, time: string) => void) => () => void
  downloadTaskEnd: (callback: (liveId: string, filePath: string) => void) => () => void
  downloadTaskError: (callback: (liveId: string, error: string) => void) => () => void
  downloadTaskStop: (liveId: string) => void
  downloadTaskList: () => Promise<TaskSnapshot[]>
  downloadTaskRemove: (liveId: string) => Promise<void>

  // ===== 录制任务 =====
  // 通道与下载同构
  recordTaskStart: (url: string, filename: string, liveId: string) => Promise<string>
  recordTaskProgress: (callback: (liveId: string, time: string) => void) => () => void
  recordTaskEnd: (callback: (liveId: string, filePath: string) => void) => () => void
  recordTaskError: (callback: (liveId: string, error: string) => void) => () => void
  recordTaskStop: (liveId: string) => void
  recordTaskList: () => Promise<TaskSnapshot[]>
  recordTaskRemove: (liveId: string) => Promise<void>

  // ===== 窗口与电源 =====
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  windowOnMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
  // preventSleep 返回 powerSaveBlocker id
  preventSleep: () => Promise<number>
  allowSleep: (id: number) => Promise<void>
}

// 渲染进程全局 Window 声明：类型契约仍以本文件为唯一来源，
// 避免 index.ts（含 Electron 实现细节）进入渲染层类型程序。
declare global {
  interface Window {
    electron: electronAPI
    mainAPI: mainAPI
  }
}
