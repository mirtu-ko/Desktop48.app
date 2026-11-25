/**
 * 更新模块的共用类型。State 是本次会话快照（广播给窗口），Memory 是跨会话落盘的几个字段。
 * 用「phase + 可选载荷」而非可辨识联合：UI 同时要看版本号、进度、上次检查时间。
 */

/** `available` 专指「只能手动获取」（mac / 免安装版）。 */
export type UpdaterPhase
  = | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'error'
    | 'unsupported'

export interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdateCandidate {
  version: string
  /** 原文可能含 markdown，渲染端自行裁剪 */
  releaseNotes: string
  /** in-app：应用内下载安装；manual：只能引导到下载页 */
  delivery: 'in-app' | 'manual'
  /** manual 的落地页，也是下载失败时的逃生门 */
  url?: string
  source: 'mirror' | 'github'
}

/** 由主进程按 `dismissedVersion` 算好，渲染端纯展示。 */
export interface UpdateNotice {
  version: string
  kind: 'ready' | 'available'
}

export interface UpdaterState {
  phase: UpdaterPhase
  currentVersion: string
  /** null 表示本次会话还没查过 */
  checkedAt: number | null
  candidate: UpdateCandidate | null
  download: DownloadProgress | null
  /** 已中文化的文案，仅 error 态非空 */
  error: string | null
  unsupported: { reason: string, url?: string } | null
  notice: UpdateNotice | null
}

/** 落盘在 userData/updater-memory.json，字段刻意保持个位数。 */
export interface UpdaterMemory {
  lastCheckAt: number | null
  lastResult: 'ok' | 'error' | 'skipped' | null
  /** 磁盘上已有安装包的版本；下次启动据此静默安装 */
  downloadedVersion: string | null
  dismissedVersion: string | null
  /** 「稍后」的时间点；过期后会再提示 */
  dismissedAt: number | null
  /** 上次自动安装尝试，用于识别「装完又回来」的重启环 */
  installAttempt: { version: string, at: number } | null
}

export interface UpdaterBackend {
  mode: UpdateCandidate['delivery']
  /** 有新版返回 candidate，已是最新返回 null */
  check: (signal?: AbortSignal) => Promise<UpdateCandidate | null>
  download?: (candidate: UpdateCandidate, onProgress: (progress: DownloadProgress) => void, signal: AbortSignal) => Promise<void>
  /** 调用后进程通常会被安装器接管 */
  install?: () => void
}
