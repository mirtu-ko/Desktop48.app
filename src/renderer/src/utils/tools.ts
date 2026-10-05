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
 * 跨任务的同名冲突由主进程 Start 前的冲突检测兜底（自动加序号）
 */
function taskFilename(realName: string, startTime: number, ext: string, separator = ''): string {
  return `${realName}${separator}${dayjs(startTime).format('YYYYMMDDHHmm')}.${ext}`
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

/**
 * 队色归一化：接口下发的队色是裸 HEX（无 #，见 member-merge 的 teamColor / ringColor 注释），
 * 交给 CSS 前要补上 #。已经是 # 开头的原样返回 —— 无脑拼前缀会得到 `##abc123` 这种废值。
 *
 * 空值返回空串而不是 '#'：调用方普遍写成 `toHex(x) || 兜底色` 或直接塞进
 * `--accent`，返回 '#' 会产出非法颜色、把兜底也一并吃掉。
 */
function toHex(color: string | undefined): string {
  const value = (color || '').trim()
  if (!value)
    return ''
  return value.startsWith('#') ? value : `#${value}`
}

/**
 * 队色 → 内联 CSS 变量的样式对象：无队色时返回 undefined（不注入变量，交给 CSS 兜底）。
 * 调用点原本一律写成 `:style="x.teamColor ? { '--tb-color': `#${x.teamColor}` } : undefined"`，
 * 空值会拼出非法的 `'#'`；变量名各有不同（--tb-color / --avatar-accent），故由调用方传入。
 */
function colorVarStyle(name: string, color: string | undefined): Record<string, string> | undefined {
  const hex = toHex(color)
  return hex ? { [name]: hex } : undefined
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
}

export default Tools
