/** 图片下载共用规则：主进程批量落盘与渲染层单图下载必须使用同一套文件名 / 小图判定。 */

/** 批量下载时「小图片」的短边阈值（px）：表情图、小贴纸等通常远小于此值 */
export const SMALL_IMAGE_MIN_SIDE = 240

/** 图片 MIME → 扩展名；仅用于「URL 尾段没有扩展名」时补全，取不到就不猜 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

/** Windows 文件名非法字符统一替换，避免下载被系统改名或拒绝 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function urlBaseName(url: string): string {
  try {
    const { pathname } = new URL(url)
    const base = sanitize(decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)))
    return base === '.' || base === '..' ? '' : base
  }
  catch {
    return ''
  }
}

/** URL 自带扩展名优先，否则按响应 MIME 推断；都没有返回空串 */
export function pickFileExtension(url: string, contentType = ''): string {
  const fromUrl = urlBaseName(url).match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? ''
  if (fromUrl)
    return fromUrl.toLowerCase()
  return EXT_BY_MIME[contentType.split(';')[0].trim().toLowerCase()] ?? ''
}

/**
 * 从 URL 与响应 content-type 推文件名。
 * URL 常带 query（?x-oss-process=... 之类），只认 pathname 的末段；
 * 无末段（以 / 结尾）或整串解析失败时退化为时间戳名。
 */
export function pickFileName(url: string, contentType = ''): string {
  const base = urlBaseName(url)
  const ext = pickFileExtension(url, contentType)
  if (!base)
    return `image-${Date.now()}${ext ? `.${ext}` : ''}`
  // 已带扩展名就尊重原样（服务端给的后缀比 content-type 更贴近用户预期）
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(base))
    return `${base}.${ext}`
  return base
}

export interface AlbumFileNameOptions {
  /** 消息时间（ms）；无效或 0 时使用当前时间 */
  timestamp?: number
  /** 发送者昵称；会清理非法字符并限长 */
  nickname?: string
  width?: number
  height?: number
  /** 相册内序号（1 起），用于同秒 / 同昵称图片排序且天然避免重名 */
  sequence: number
  url: string
  contentType?: string
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/**
 * 相册批量下载的可读文件名：
 * `粉丝甲_20261022-215544_1200x1600_01.jpg`
 * 昵称在最前，便于按发送者浏览；其后是消息时间、原始尺寸与时间序，
 * 即使同秒多条也不会互相覆盖。
 */
export function buildAlbumFileName(options: AlbumFileNameOptions): string {
  const timestamp = options.timestamp && Number.isFinite(options.timestamp) ? options.timestamp : Date.now()
  let date = new Date(timestamp)
  if (Number.isNaN(date.getTime()))
    date = new Date()
  const time = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const nickname = sanitize(options.nickname ?? '').replace(/\s+/g, ' ').slice(0, 24)
  const width = options.width ?? 0
  const height = options.height ?? 0
  const size = width > 0 && height > 0 ? `_${Math.round(width)}x${Math.round(height)}` : ''
  const sequence = `_${pad(Math.max(1, Math.trunc(options.sequence)), 2)}`
  const ext = pickFileExtension(options.url, options.contentType)
  return `${nickname ? `${nickname}_` : ''}${time}${size}${sequence}${ext ? `.${ext}` : ''}`
}

/** 尺寸已知且短边小于阈值：无需请求即可判定为小图 */
export function isSmallImage(width?: number, height?: number, minSide = SMALL_IMAGE_MIN_SIDE): boolean {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0) {
    return false
  }
  return Math.min(width, height) < minSide
}
