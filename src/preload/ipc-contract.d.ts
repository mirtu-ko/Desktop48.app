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
import type { AppConfig, ConfigKey } from '../common/app-config'
import type { MemberFlag, MemberFlagKind } from '../common/member-flags'
import type { AllMemberItem, MemberDataContent, StarAdjunctItem, StarInfoItem } from '../main/data'
import type { TaskSnapshot } from '../main/ffmpeg/task-registry'

// ===== 基础环境 =====

// 渲染进程所需的最小运行环境信息
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

// 类型随契约一起暴露（preload/index.ts 实现侧与渲染端合并函数引用）
export type { AllMemberItem, MemberDataContent, StarAdjunctItem }

// 类型随契约一起暴露（preload/index.ts 实现侧与渲染端引用）
export type { MemberFlag, MemberFlagKind }
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

/** getAllMembers 返回：h5.48.cn 落库的 allmembers 成员名单 + 兼职成员档案（见 main/data.ts 对应类型） */
export interface AllMembersPayload {
  allmembers: AllMemberItem[]
  /** starAdjunctInfo 兼职成员档案（status===1 为有效兼任，渲染端据此归入兼任队伍） */
  adjuncts?: StarAdjunctItem[]
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

// ===== 类型化 IPC 通道映射 =====

interface InvokeSpec<Args extends readonly unknown[], Return> {
  args: Args
  return: Return
}

/** 通用任务通道前缀；具体通道由 `${prefix}Start|List|Remove|Progress|End|Error` 组成。 */
export type TaskChannelPrefix = 'downloadTask' | 'recordTask'

interface StaticIpcInvokeMap {
  netRequest: InvokeSpec<[options: NetRequestOptions], string>
  saveMemberData: InvokeSpec<[content: Partial<MemberDataContent>], { ok: true }>
  getAllMembers: InvokeSpec<[], AllMembersPayload>
  hasMembers: InvokeSpec<[], boolean>
  getMemberInfo: InvokeSpec<[userId: number], MemberInfo | undefined>
  getMemberTree: InvokeSpec<[], MemberTreeGroupPayload[]>
  getMemberFlags: InvokeSpec<[kind: MemberFlagKind], MemberFlag[]>
  setMemberFlags: InvokeSpec<[kind: MemberFlagKind, ids: Array<number | string>], void>
  addMemberFlag: InvokeSpec<[kind: MemberFlagKind, userId: number], void>
  removeMemberFlag: InvokeSpec<[kind: MemberFlagKind, userId: number], void>
  getConfig: InvokeSpec<[key: ConfigKey], string>
  setConfig: InvokeSpec<[key: ConfigKey, value: string], void>
  openPath: InvokeSpec<[filePath: string], void>
  getDesktopPath: InvokeSpec<[], string>
  selectDirectory: InvokeSpec<[], string | null>
  pathJoin: InvokeSpec<[...paths: string[]], string>
  checkFfmpegBinaries: InvokeSpec<[dir: string], boolean>
  downloadFfmpeg: InvokeSpec<[], string>
  createLiveStream: InvokeSpec<[rtmpUrl: string, liveId: string], LiveStreamSession>
  stopLiveStream: InvokeSpec<[liveId: string], void>
  windowMinimize: InvokeSpec<[], void>
  windowToggleMaximize: InvokeSpec<[], void>
  windowClose: InvokeSpec<[], void>
  windowIsMaximized: InvokeSpec<[], boolean>
  preventSleep: InvokeSpec<[], number>
  allowSleep: InvokeSpec<[id: number], void>
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
}

export type IpcEventMap = {
  ffmpegDownloadProgress: [progress: FfmpegDownloadProgress]
  windowOnMaximizeChange: [isMaximized: boolean]
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
  getPlatform: () => string
  onFfmpegDownloadProgress: (callback: (progress: FfmpegDownloadProgress) => void) => () => void
  downloadTaskStop: (liveId: string) => void
  recordTaskStop: (liveId: string) => void
}

// 渲染进程全局 Window 声明：类型契约仍以本文件为唯一来源，
// 避免 index.ts（含 Electron 实现细节）进入渲染层类型程序。
declare global {
  interface Window {
    electron: electronAPI
    mainAPI: mainAPI
  }
}
