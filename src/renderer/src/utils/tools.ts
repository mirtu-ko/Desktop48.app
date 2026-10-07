import dayjs from 'dayjs'

/** 一直播 HLS 域名：streamPathHandle 只对它的路径前缀做重写 */
const YI_ZHI_BO_HOST = 'alcdn.hls.xiaoka.tv'

/** 流地址前缀：http(s)://host/{数字} */
const STREAM_PATH_REGEX = /^(http|https):\/\/([^/]+)\/(\d+)/

/**
 * 将相对路径 / 相对图片路径归一化为 source.48.cn 完整 URL；已是完整 URL 时原样返回
 */
function toSourceUrl(path: string): string {
  // 空进空出：空串拼前缀会产出必然 404 的垃圾 URL（头像位碎图的根源）
  if (!path)
    return ''
  if (path.endsWith('.png.png'))
    path = path.replace('.png.png', '.png')
  if (path.includes('http'))
    return path
  return `https://source.48.cn${path}`
}

/**
 * 将逗号分隔的图片路径转换为完整的URL数组
 */
function pictureUrls(picturesStr: string) {
  // teamLogo 等字段为可选，数据缺失（undefined/null）时返回空数组，
  // 避免 .split 抛错导致整页列表加载失败
  if (!picturesStr)
    return []
  return picturesStr.split(',').map(picture => toSourceUrl(picture))
}

/** 归一单个图片地址为可直接 <img src> 的 URL */
function sourceUrl(sourcePath: string) {
  return toSourceUrl(sourcePath)
}

function timeToSecond(time: string): number {
  if (!time) {
    return 0
  }
  const [hours, minutes, seconds] = time.split(':')
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

function lyricsParse(lyrics: string) {
  if (!lyrics) {
    console.error('lyrics undefined')
    return []
  }
  const barrages: any[] = []
  const lines = lyrics.split('\n')
  lines.forEach((line: string) => {
    const tmp = line.split(']')
    if (tmp.length > 1) {
      const arr = tmp[1].split('\t')
      barrages.push({
        time: tmp[0].replace('[', ''),
        username: arr[0],
        content: arr[1],
      })
    }
  })
  return barrages
}

function streamPathHandle(streamPath: string, timestamp: number) {
  // 月日不补零（2026+9+5），与一直播下发的目录格式一致
  const liveDate = dayjs(timestamp).format('YYYYMD')
  return streamPath.replace(STREAM_PATH_REGEX, (pathPrefix, protocol, host) => {
    if (host.toLowerCase() !== YI_ZHI_BO_HOST) {
      return pathPrefix
    }

    return `${protocol}://${host}/${liveDate}`
  })
}

/**
 * 下载/录制任务文件名：成员名 + 任务开始时间（yyyyMMddhhmm）+ 扩展名。
 * separator 为成员名与时间戳之间的分隔符（录制为空格、回放下载紧连，保持既有命名）；
 * 同场直播同一时刻只允许一个任务，文件名保持分钟精度即可，
 * 跨任务的同名冲突由主进程 Start 前的冲突检测兜底（自动加序号）。
 * 录制名取自直播标题，可能含文件名非法字符（如「4/8班联合公演」的斜杠，
 * 主进程按路径穿越防御会拒绝），这里统一替换成下划线
 */
function taskFilename(realName: string, startTime: number, ext: string, separator = ''): string {
  const safeName = realName.replace(/[/\\:*?"<>|]/g, '_')
  return `${safeName}${separator}${dayjs(startTime).format('YYYYMMDDHHmm')}.${ext}`
}

/**
 * 队伍名展示名：剥掉 TEAM 前缀（TEAM SII → SII）
 */
function shortTeamName(teamName: string): string {
  return (teamName || '').replace('TEAM ', '')
}

/**
 * userId 归一化：成员树为 number，接口可能为 string。
 * 用 Number 而非 parseInt：'123abc' 这类脏值应判为无效，而不是被截断成 123 误命中别人。
 * 关注 / 屏蔽 / 成员名录三个 store 与直播列表的屏蔽过滤共用同一份口径。
 */
function normalizeUserId(userId: number | string | undefined | null): number {
  if (typeof userId === 'number')
    return userId
  const text = String(userId ?? '').trim()
  return text ? Number(text) : Number.NaN
}

/** 队色归一化：接口下发的是裸 HEX，交给 CSS 前补 #；已带 # 的原样返回。空值返回空串，不能返回 '#'（会产出非法颜色并吃掉调用方的兜底） */
function toHex(color: string | undefined): string {
  const value = (color || '').trim()
  if (!value)
    return ''
  return value.startsWith('#') ? value : `#${value}`
}

/** 队色 → 内联 CSS 变量的样式对象：无队色时返回 undefined（不注入变量，交给 CSS 兜底）。变量名由调用方传入 */
function colorVarStyle(name: string, color: string | undefined): Record<string, string> | undefined {
  const hex = toHex(color)
  return hex ? { [name]: hex } : undefined
}

/** 亮底上用的深墨（带一点品牌紫，比纯黑柔和） */
const DARK_INK = '#2b2440'

/**
 * 依据背景亮度挑可读的前景色：亮底给深墨，暗底给纯白。
 *
 * 分团 tab 的激活态用它 —— 各团体色的明度跨度极大（SNH48 #8FD3F6 的浅蓝 ↔ CGT48 #D21217 的深红），
 * 一律用白字会让浅色底上的文字糊成一片，激活与未激活就分不出来了。
 * 认不出颜色（如 `var(--color-members)` 这类 CSS 变量）时按白字兜底：现有的变量色都是中深色。
 */
function readableInk(background: string | undefined): string {
  const matched = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(toHex(background))
  if (!matched)
    return '#fff'
  const raw = matched[1]
  const full = raw.length === 3 ? raw.replace(/./g, char => char + char) : raw
  const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(full.slice(offset, offset + 2), 16))
  // sRGB 加权亮度，够用即可，不必上 gamma 校正
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luma > 0.62 ? DARK_INK : '#fff'
}

/**
 * 纯函数工具集：不依赖 DOM、IPC 或响应式状态。
 */
const Tools = {
  pictureUrls,
  sourceUrl,
  timeToSecond,
  lyricsParse,
  streamPathHandle,
  taskFilename,
  shortTeamName,
  normalizeUserId,
  toHex,
  colorVarStyle,
  readableInk,
}

export default Tools
