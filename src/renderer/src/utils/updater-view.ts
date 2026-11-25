/**
 * 更新界面的文案与按钮推导（纯函数）：主进程只管状态，说什么话由这里决定。
 */
import type { UpdaterProgress, UpdaterState } from '@preload/ipc-contract'

/** 官网下载页：manual 态的落地页，也是下载失败时的逃生门。 */
export const DOWNLOAD_PAGE_URL = 'https://48.v2ing.com/'

export interface UpdaterAction {
  label: string
  kind: 'check' | 'download' | 'install' | 'open-page' | 'none'
  url?: string
  disabled?: boolean
  loading?: boolean
}

/** 设置页「版本」行的一句话状态。 */
export function describeUpdater(state: UpdaterState, now = Date.now()): string {
  const version = state.candidate?.version ?? state.currentVersion

  switch (state.phase) {
    case 'checking':
      return '正在检查更新，请稍候…'
    case 'up-to-date':
      return `当前已是最新版本${relativeCheckedAt(state.checkedAt, now)}`
    case 'available':
      return `发现新版本 v${version}，需手动下载安装`
    case 'downloading':
      return `正在下载新版本 v${version}…`
    case 'ready':
      return `新版本 v${version} 已下载完成，重启后生效`
    case 'installing':
      return '正在安装新版本，应用即将重启…'
    case 'error':
      return state.error ?? '更新失败，请稍后重试'
    case 'unsupported':
      return state.unsupported?.reason ?? '当前环境不支持自动更新'
    default:
      return '检查是否有可用的新版本'
  }
}

/** 主按钮：每个阶段只一个主要动作，次要的「重新检查」由卡片自己加。 */
export function resolveUpdaterAction(state: UpdaterState): UpdaterAction {
  switch (state.phase) {
    case 'checking':
      return { label: '检查中', kind: 'none', disabled: true, loading: true }
    case 'downloading':
      return { label: '下载中', kind: 'none', disabled: true, loading: true }
    case 'installing':
      return { label: '安装中', kind: 'none', disabled: true, loading: true }
    case 'ready':
      return { label: '立即重启', kind: 'install' }
    case 'available':
      return { label: '去下载', kind: 'open-page', url: state.candidate?.url ?? DOWNLOAD_PAGE_URL }
    case 'error':
      // 自动下载失败多为网络抖动，「重试」比再查一次直接
      return state.candidate?.delivery === 'in-app'
        ? { label: '重试下载', kind: 'download' }
        : { label: '重新检查', kind: 'check' }
    case 'unsupported':
      return state.unsupported?.url
        ? { label: '去下载', kind: 'open-page', url: state.unsupported.url }
        : { label: '检查更新', kind: 'none', disabled: true }
    default:
      return { label: '检查更新', kind: 'check' }
  }
}

export interface BannerContent {
  title: string
  description: string
  primaryLabel: string
  kind: 'install' | 'open-page'
  url?: string
}

/** 顶部横幅：主进程算出 notice 时才出现，一版一次。 */
export function bannerContent(state: UpdaterState): BannerContent | null {
  const notice = state.notice
  if (!notice)
    return null

  if (notice.kind === 'ready')
    return { title: `新版本 v${notice.version} 已下载`, description: '重启应用即可完成更新', primaryLabel: '立即重启', kind: 'install' }

  return {
    title: `发现新版本 v${notice.version}`,
    description: '当前系统无法自动更新，只能手动下载安装包',
    primaryLabel: '去下载',
    kind: 'open-page',
    url: state.candidate?.url ?? DOWNLOAD_PAGE_URL,
  }
}

/** 下载进度下方的「已传 / 总量 · 速率」。 */
export function downloadSizeText(progress: UpdaterProgress | null): string {
  if (!progress || progress.total <= 0)
    return ''
  return `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)} · ${formatBytes(progress.bytesPerSecond)}/s`
}

/** 字节数 → 人类可读。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

/** 上次检查的相对时间；没查过就不显示后缀。 */
export function relativeCheckedAt(checkedAt: number | null, now = Date.now()): string {
  if (!checkedAt)
    return ''
  const minutes = Math.floor((now - checkedAt) / 60_000)
  if (minutes < 1)
    return '（刚刚检查）'
  if (minutes < 60)
    return `（${minutes} 分钟前检查）`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `（${hours} 小时前检查）`
  return `（${Math.floor(hours / 24)} 天前检查）`
}
