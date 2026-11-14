/**
 * 生日贺卡卡面 / 分享图（纯 Canvas 2D）：预览、复制、保存共用同一张 1080×1440 PNG。
 * 顶部是可脱离 DOM 单测的纯函数（祝福语 / 日期 / 文件名 / 配色 / data URL 转 Blob），底部才碰 document。
 *
 * 头像必须走 `loadPosterAvatar`（主进程取回 data URL）再画进画布：
 * 直接画跨域 <img> 会污染 canvas，toDataURL 会抛 SecurityError。
 */
import type { BirthdayEntry } from '@renderer/utils/member-birthday'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { sanitizeFileName } from '@common/image-download'
import dayjs from 'dayjs'

export interface BirthdayPosterOptions {
  entry: BirthdayEntry
  today: Date
  wish: string
  /** 已转成 data URL 的头像；为空时降级为姓名首字 */
  avatar?: HTMLImageElement | null
  /** 装扮变体：只切换装饰配色，不改文案；「换装扮」按钮切换 */
  decor?: number
}

export interface BirthdayPosterResult {
  /** PNG data URL：卡面预览、写剪贴板、存盘共用这一份 */
  dataUrl: string
  /** 同内容的 Blob：渲染层 clipboard API 的兜底载荷 */
  blob: Blob
}

export const POSTER_WIDTH = 1080
export const POSTER_HEIGHT = 1440

const CN_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const EN_FONT = '"Arial", "Helvetica Neue", sans-serif'
const TAU = Math.PI * 2

/** 每次打开贺卡随机取一句；「换一句」按此顺序轮换。星点等装饰另按姓名稳定散列 */
export const BIRTHDAY_WISHES: readonly string[] = [
  '愿新的一岁，所遇皆温柔，所行皆坦途。',
  '愿每一束光都为你而亮，每一个舞台都因你闪耀。',
  '又长大一岁，愿热爱不减，掌声常在。',
  '把今天的星光都送给你，生日快乐。',
  '愿你始终被偏爱，也始终有奔赴热爱的勇气。',
  '岁月赠你以光，你回舞台以歌。生日快乐。',
]

export interface BirthdayPalette {
  /** 装扮名，按钮上展示 */
  name: string
  gold: string
  goldSoft: string
  pink: string
  lilac: string
  halo: string
  flags: readonly string[]
}

/** 三套装扮：只改装饰与描边配色，卡面内容（头像 / 姓名 / 祝福语）保持不变 */
export const BIRTHDAY_PALETTES: readonly BirthdayPalette[] = [
  {
    name: '鎏金',
    gold: '#ffd166',
    goldSoft: '#ffe6a8',
    pink: '#ff8fb8',
    lilac: '#a89df6',
    halo: 'rgba(255, 190, 100, 0.30)',
    flags: ['#ffd166', '#ff8fb8', '#a89df6', '#fff2d0', '#ffb45e'],
  },
  {
    name: '星海',
    gold: '#9ee7ff',
    goldSoft: '#d7f4ff',
    pink: '#c9a7ff',
    lilac: '#8fb8ff',
    halo: 'rgba(140, 200, 255, 0.30)',
    flags: ['#9ee7ff', '#c9a7ff', '#8fb8ff', '#ffffff', '#ffd6f0'],
  },
  {
    name: '蜜桃',
    gold: '#ffb37b',
    goldSoft: '#ffe3b0',
    pink: '#ff9ba8',
    lilac: '#ffcf8f',
    halo: 'rgba(255, 170, 110, 0.30)',
    flags: ['#ffb37b', '#ffe38f', '#ff9ba8', '#fff2d0', '#ffc0d9'],
  },
]

/** 装扮按变体循环，负变体也归一化到有效下标 */
export function pickBirthdayPalette(variant = 0): BirthdayPalette {
  const size = BIRTHDAY_PALETTES.length
  return BIRTHDAY_PALETTES[((variant % size) + size) % size]
}

/** 稳定散列：让星点 / 彩旗 / 彩带的分布跟着成员固定，不出现同一人两张图不一样 */
function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++)
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

function seededRandom(seed: number): () => number {
  let state = (seed || 1) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 卡面中央的生辰日期：11.13 */
export function birthdayStamp(entry: BirthdayEntry): string {
  return `${pad2(entry.month)}.${pad2(entry.day)}`
}

/** 卡面身份标签：贺卡只承载今日寿星 */
const BADGE_LABEL = '今日生辰'

/** 保存对话框的建议文件名：中文姓名保留，非法字符与空白按共用规则去掉 */
export function posterFileName(entry: BirthdayEntry, today: Date): string {
  const name = sanitizeFileName(entry.member.realName, '').replace(/\s+/g, '') || 'member'
  return `Desktop48-生日贺卡-${name}-${dayjs(today).format('YYYYMMDD')}.png`
}

/** PNG data URL → Blob：卡面只做一次 PNG 编码，剪贴板兜底载荷由 base64 还原 */
export function pngDataUrlToBlob(dataUrl: string): Blob {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix))
    throw new Error('不是 PNG data URL')
  const binary = atob(dataUrl.slice(prefix.length))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}

/**
 * 每次打开贺卡时随机取一句祝福。avoid 传上一次展示的句子，避免连续两次打开撞到同一句；
 * 词库只有一句时无法避开。只影响文案，卡面装饰仍按成员姓名稳定散列。
 */
export function randomBirthdayWish(avoid = ''): string {
  const size = BIRTHDAY_WISHES.length
  let index = Math.min(size - 1, Math.floor(Math.random() * size))
  if (size > 1 && BIRTHDAY_WISHES[index] === avoid)
    index = (index + 1) % size
  return BIRTHDAY_WISHES[index]
}

/** 「换一句」：按词库顺序取下一句；当前句不在词库内时从第一句开始 */
export function nextBirthdayWish(current: string): string {
  const index = BIRTHDAY_WISHES.findIndex(item => item === current)
  return BIRTHDAY_WISHES[(index + 1) % BIRTHDAY_WISHES.length]
}

/**
 * 取可安全入画布的头像。远程 CDN 不给 CORS 头，渲染层 fetch / <img crossOrigin> 都拿不到
 * 可绘制的位图，故由主进程 net.request 收二进制再回传 data URL。
 * 任何一步失败都返回 null，卡面与分享图一起降级为姓名首字，不会出现「卡上有照片、分享图没有」。
 */
export async function loadPosterAvatar(url: string): Promise<HTMLImageElement | null> {
  if (!url)
    return null
  try {
    const dataUrl = await window.mainAPI.imageDataUrl(url)
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    return image
  }
  catch {
    return null
  }
}

// ===== 绘制 =====

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** 四角星：装饰用，比圆点更像「星光」 */
function drawSparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha = 1,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(0, -r)
  ctx.quadraticCurveTo(r * 0.16, -r * 0.16, r, 0)
  ctx.quadraticCurveTo(r * 0.16, r * 0.16, 0, r)
  ctx.quadraticCurveTo(-r * 0.16, r * 0.16, -r, 0)
  ctx.quadraticCurveTo(-r * 0.16, -r * 0.16, 0, -r)
  ctx.fill()
  ctx.restore()
}

/** 手动字距：Canvas 的 letterSpacing 在部分 Chromium 版本上不生效，逐字画最稳 */
function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  spacing: number,
  font: string,
  color: string | CanvasGradient,
): void {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  const chars = [...text]
  const widths = chars.map(char => ctx.measureText(char).width)
  const total = widths.reduce((sum, width) => sum + width, 0) + spacing * (chars.length - 1)
  let x = cx - total / 2
  chars.forEach((char, index) => {
    ctx.fillText(char, x, y)
    x += widths[index] + spacing
  })
}

/** 长姓名自动缩字号，避免溢出画框 */
function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  weight: number,
  baseSize: number,
  color: string | CanvasGradient,
): void {
  let size = baseSize
  // 先无条件落字体：baseSize <= 44（如队伍名 34px）时下面的 while 一次都不进，
  // 沿用上一处 ctx.font 会把队伍名画成姓名的字号并压在一起
  ctx.font = `${weight} ${size}px ${CN_FONT}`
  while (size > 24 && ctx.measureText(text).width > maxWidth) {
    size -= 4
    ctx.font = `${weight} ${size}px ${CN_FONT}`
  }
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.fillText(text, cx, y)
}

/** 中文按实测宽度折行，返回占用的行数 */
function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  ctx.font = `400 34px ${CN_FONT}`
  ctx.fillStyle = 'rgba(255, 248, 235, 0.94)'
  ctx.textAlign = 'center'
  const lines: string[] = []
  let line = ''
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > maxWidth) {
      lines.push(line)
      line = char
    }
    else {
      line += char
    }
  }
  if (line)
    lines.push(line)
  lines.forEach((item, index) => ctx.fillText(item, cx, y + index * lineHeight))
  return lines.length
}

/** 顶部弧形彩旗串：沿二次贝塞尔取点挂三角旗 */
function drawBunting(ctx: CanvasRenderingContext2D, palette: BirthdayPalette, rand: () => number): void {
  const start = { x: 82, y: 96 }
  const ctrl = { x: 540, y: 214 }
  const end = { x: 998, y: 96 }
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 236, 200, 0.52)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.quadraticCurveTo(ctrl.x, ctrl.y, end.x, end.y)
  ctx.stroke()

  const count = 15
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count
    const inv = 1 - t
    const x = inv * inv * start.x + 2 * inv * t * ctrl.x + t * t * end.x
    const y = inv * inv * start.y + 2 * inv * t * ctrl.y + t * t * end.y
    const w = 30
    const h = 40 + rand() * 10
    ctx.globalAlpha = 0.78 + rand() * 0.2
    ctx.fillStyle = palette.flags[i % palette.flags.length]
    ctx.beginPath()
    ctx.moveTo(x - w / 2, y + 2)
    ctx.lineTo(x + w / 2, y + 2)
    ctx.lineTo(x, y + h)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
    ctx.beginPath()
    ctx.moveTo(x - w / 2, y + 2)
    ctx.lineTo(x, y + 2)
    ctx.lineTo(x, y + h)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

function drawBalloon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  sway: number,
): void {
  ctx.save()
  ctx.globalAlpha = 0.78
  ctx.strokeStyle = 'rgba(255, 236, 200, 0.38)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(x, y + ry)
  ctx.quadraticCurveTo(x + sway, y + ry + 92, x + sway * 0.35, y + ry + 178)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU)
  ctx.fill()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)'
  ctx.beginPath()
  ctx.ellipse(x - rx * 0.34, y - ry * 0.36, rx * 0.18, ry * 0.28, -0.4, 0, TAU)
  ctx.fill()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x - 6, y + ry - 2)
  ctx.lineTo(x + 6, y + ry - 2)
  ctx.lineTo(x, y + ry + 9)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 头像两侧各挂两只气球，压低透明度，不跟正中肖像抢视觉 */
function drawBalloons(ctx: CanvasRenderingContext2D, palette: BirthdayPalette, rand: () => number): void {
  const groups = [
    { x: 118, y: 474, color: palette.pink, sway: 22 },
    { x: 88, y: 620, color: palette.lilac, sway: -18 },
    { x: 962, y: 474, color: palette.lilac, sway: -22 },
    { x: 992, y: 620, color: palette.pink, sway: 18 },
  ]
  for (const item of groups) {
    drawBalloon(ctx, item.x, item.y + rand() * 18, 30, 40, item.color, item.sway)
    drawSparkle(ctx, item.x + 46, item.y - 46, 9, palette.goldSoft, 0.7)
  }
}

/** 肖像上方的蝴蝶结缎带 */
function drawBow(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.fillStyle = color
  ctx.globalAlpha = 0.92
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.quadraticCurveTo(side * 44, -30, side * 40, 6)
    ctx.quadraticCurveTo(side * 34, 26, 0, 0)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(side * 3, 4)
    ctx.lineTo(side * 26, 40)
    ctx.lineTo(side * 10, 32)
    ctx.lineTo(0, 8)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = '#fff3d0'
  ctx.beginPath()
  ctx.arc(0, 0, 10, 0, TAU)
  ctx.fill()
  ctx.restore()
}

/** 底部双层蛋糕 + 三支蜡烛 */
function drawCake(ctx: CanvasRenderingContext2D, cx: number, bottomY: number, palette: BirthdayPalette): void {
  const w1 = 126
  const h1 = 42
  const w2 = 88
  const h2 = 36
  const y1 = bottomY - h1
  const y2 = y1 - h2
  ctx.save()
  ctx.fillStyle = 'rgba(255, 232, 184, 0.26)'
  ctx.beginPath()
  ctx.ellipse(cx, bottomY + 7, 88, 12, 0, 0, TAU)
  ctx.fill()

  const tier = ctx.createLinearGradient(cx - w1 / 2, y1, cx + w1 / 2, bottomY)
  tier.addColorStop(0, palette.pink)
  tier.addColorStop(1, palette.lilac)
  ctx.fillStyle = tier
  roundRect(ctx, cx - w1 / 2, y1, w1, h1, 8)
  ctx.fill()
  ctx.fillStyle = 'rgba(255, 246, 220, 0.92)'
  roundRect(ctx, cx - w1 / 2, y1 - 7, w1, 14, 7)
  ctx.fill()

  ctx.fillStyle = palette.goldSoft
  roundRect(ctx, cx - w2 / 2, y2, w2, h2, 7)
  ctx.fill()
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
  roundRect(ctx, cx - w2 / 2, y2 - 6, w2, 12, 6)
  ctx.fill()

  for (const dx of [-26, 0, 26]) {
    ctx.fillStyle = '#fff1c9'
    ctx.fillRect(cx + dx - 4, y2 - 26, 8, 24)
    ctx.save()
    ctx.shadowColor = palette.gold
    ctx.shadowBlur = 16
    ctx.fillStyle = palette.gold
    ctx.beginPath()
    ctx.ellipse(cx + dx, y2 - 33, 4, 8, 0, 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = i % 2 ? palette.lilac : '#ffffff'
    ctx.beginPath()
    ctx.arc(cx - 48 + i * 12, bottomY - 16, 2.6, 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

/** 底部两角的礼物盒 */
function drawGift(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, box: string, ribbon: string): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = box
  roundRect(ctx, -size / 2, -size / 2 + 10, size, size - 10, 6)
  ctx.fill()
  ctx.fillStyle = ribbon
  ctx.fillRect(-6, -size / 2 + 10, 12, size - 10)
  ctx.fillRect(-size / 2, -size / 2 + size * 0.38, size, 10)
  ctx.fillStyle = box
  roundRect(ctx, -size / 2 - 5, -size / 2, size + 10, 14, 4)
  ctx.fill()
  ctx.strokeStyle = ribbon
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(0, -size / 2)
  ctx.quadraticCurveTo(-24, -size / 2 - 26, -19, -size / 2 - 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, -size / 2)
  ctx.quadraticCurveTo(24, -size / 2 - 26, 19, -size / 2 - 2)
  ctx.stroke()
  ctx.restore()
}

/** 四角金色卷草纹样 */
function drawCorner(ctx: CanvasRenderingContext2D, x: number, y: number, sx: number, sy: number, color: string): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(sx, sy)
  ctx.globalAlpha = 0.72
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 66)
  ctx.lineTo(0, 22)
  ctx.quadraticCurveTo(0, 0, 22, 0)
  ctx.lineTo(66, 0)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(36, 36, 3.2, 0, TAU)
  ctx.fillStyle = color
  ctx.fill()
  drawSparkle(ctx, 24, 24, 8, color, 0.9)
  ctx.restore()
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  palette: BirthdayPalette,
): void {
  const bg = ctx.createLinearGradient(0, 0, POSTER_WIDTH, POSTER_HEIGHT)
  bg.addColorStop(0, '#171034')
  bg.addColorStop(0.42, '#3a1b60')
  bg.addColorStop(0.78, '#6c2559')
  bg.addColorStop(1, '#241546')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)

  const halo = ctx.createRadialGradient(540, 560, 40, 540, 560, 720)
  halo.addColorStop(0, palette.halo)
  halo.addColorStop(0.48, 'rgba(255, 132, 178, 0.12)')
  halo.addColorStop(1, 'rgba(255, 132, 178, 0)')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)

  const corner = ctx.createRadialGradient(80, 1360, 10, 80, 1360, 560)
  corner.addColorStop(0, 'rgba(168, 157, 246, 0.24)')
  corner.addColorStop(1, 'rgba(168, 157, 246, 0)')
  ctx.fillStyle = corner
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)

  for (let i = 0; i < 150; i++) {
    const x = rand() * POSTER_WIDTH
    const y = rand() * POSTER_HEIGHT
    const radius = rand() * 2.2 + 0.4
    ctx.globalAlpha = 0.16 + rand() * 0.68
    ctx.fillStyle = rand() > 0.72 ? palette.goldSoft : '#ffffff'
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, TAU)
    ctx.fill()
  }

  for (let i = 0; i < 58; i++) {
    const x = rand() * POSTER_WIDTH
    const y = rand() * POSTER_HEIGHT * 0.94
    const w = 8 + rand() * 16
    const h = 16 + rand() * 34
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((rand() - 0.5) * 1.7)
    ctx.globalAlpha = 0.14 + rand() * 0.42
    ctx.fillStyle = palette.flags[Math.floor(rand() * palette.flags.length)]
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }
  ctx.globalAlpha = 1

  for (let i = 0; i < 12; i++) {
    drawSparkle(
      ctx,
      100 + rand() * (POSTER_WIDTH - 200),
      210 + rand() * (POSTER_HEIGHT - 420),
      5 + rand() * 9,
      palette.goldSoft,
      0.22 + rand() * 0.4,
    )
  }

  const frame = ctx.createLinearGradient(40, 40, 1040, 1400)
  frame.addColorStop(0, palette.gold)
  frame.addColorStop(0.5, 'rgba(255, 255, 255, 0.12)')
  frame.addColorStop(1, palette.pink)
  ctx.strokeStyle = frame
  ctx.lineWidth = 2
  roundRect(ctx, 40, 40, POSTER_WIDTH - 80, POSTER_HEIGHT - 80, 36)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  roundRect(ctx, 56, 56, POSTER_WIDTH - 112, POSTER_HEIGHT - 112, 28)
  ctx.stroke()

  drawCorner(ctx, 80, 80, 1, 1, palette.gold)
  drawCorner(ctx, 1000, 80, -1, 1, palette.gold)
  drawCorner(ctx, 80, 1360, 1, -1, palette.gold)
  drawCorner(ctx, 1000, 1360, -1, -1, palette.gold)
}

/** 头像按 cover 居中裁剪进圆 */
function drawCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, size: number): void {
  const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight)
  const w = image.naturalWidth * scale
  const h = image.naturalHeight * scale
  ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h)
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | null | undefined,
  member: MemberDetail,
  cx: number,
  cy: number,
  radius: number,
  palette: BirthdayPalette,
): void {
  ctx.save()
  ctx.shadowColor = palette.halo
  ctx.shadowBlur = 70
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius + 10, 0, TAU)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.setLineDash([3, 17])
  ctx.strokeStyle = palette.gold
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, radius + 36, 0, TAU)
  ctx.stroke()
  ctx.restore()

  // 外圈月桂叶：左右各七片，让肖像像一枚徽章
  ctx.save()
  ctx.translate(cx, cy)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const angle = side === -1 ? Math.PI * (0.62 + i * 0.11) : Math.PI * (-0.62 - i * 0.11)
      ctx.save()
      ctx.translate(Math.cos(angle) * (radius + 58), Math.sin(angle) * (radius + 58))
      ctx.rotate(angle + Math.PI / 2)
      ctx.globalAlpha = 0.42
      ctx.fillStyle = palette.goldSoft
      ctx.beginPath()
      ctx.ellipse(0, 0, 6, 15, 0, 0, TAU)
      ctx.fill()
      ctx.restore()
    }
  }
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * TAU
    ctx.fillStyle = i % 3 === 0 ? palette.goldSoft : 'rgba(255, 255, 255, 0.55)'
    ctx.beginPath()
    ctx.arc(Math.cos(angle) * (radius + 36), Math.sin(angle) * (radius + 36), i % 3 === 0 ? 4 : 2.4, 0, TAU)
    ctx.fill()
  }
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, TAU)
  ctx.clip()
  if (image) {
    drawCover(ctx, image, cx - radius, cy - radius, radius * 2)
  }
  else {
    const plate = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius)
    plate.addColorStop(0, '#6d5ae0')
    plate.addColorStop(1, palette.pink)
    ctx.fillStyle = plate
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    ctx.font = `700 150px ${CN_FONT}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText([...member.realName][0] || '★', cx, cy)
    ctx.textBaseline = 'alphabetic'
  }
  ctx.restore()

  const ring = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius)
  ring.addColorStop(0, '#fff2cd')
  ring.addColorStop(0.5, palette.gold)
  ring.addColorStop(1, palette.pink)
  ctx.strokeStyle = ring
  ctx.lineWidth = 9
  ctx.beginPath()
  ctx.arc(cx, cy, radius + 4, 0, TAU)
  ctx.stroke()

  drawBow(ctx, cx, cy - radius - 64, palette.pink)
  drawSparkle(ctx, cx - radius - 52, cy - radius + 20, 14, palette.goldSoft, 0.85)
  drawSparkle(ctx, cx + radius + 52, cy - radius + 20, 12, palette.goldSoft, 0.85)
}

/** 生成一张 PNG；返回的 dataUrl 与 blob 是同一份图像，卡面预览 / 复制 / 保存全部复用 */
export function renderBirthdayPoster(options: BirthdayPosterOptions): BirthdayPosterResult {
  const { entry, today, wish, avatar, decor = 0 } = options
  const member = entry.member
  const palette = pickBirthdayPalette(decor)
  const rand = seededRandom(hashText(member.realName + member.sid))
  const canvas = document.createElement('canvas')
  canvas.width = POSTER_WIDTH
  canvas.height = POSTER_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx)
    throw new Error('无法创建绘图上下文')

  drawBackground(ctx, rand, palette)
  drawBunting(ctx, palette, rand)
  drawBalloons(ctx, palette, rand)

  // 眉题
  drawSpacedText(ctx, 'HAPPY BIRTHDAY', POSTER_WIDTH / 2, 250, 15, `600 34px ${EN_FONT}`, palette.goldSoft)
  ctx.strokeStyle = 'rgba(255, 217, 143, 0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(190, 234)
  ctx.lineTo(320, 234)
  ctx.moveTo(760, 234)
  ctx.lineTo(890, 234)
  ctx.stroke()

  const title = ctx.createLinearGradient(0, 280, 0, 390)
  title.addColorStop(0, '#fff3d0')
  title.addColorStop(0.55, palette.gold)
  title.addColorStop(1, palette.pink)
  drawFittedText(ctx, '生日快乐', POSTER_WIDTH / 2, 370, 800, 800, 92, title)

  drawAvatar(ctx, avatar, member, POSTER_WIDTH / 2, 660, 180, palette)

  ctx.save()
  ctx.shadowColor = 'rgba(28, 16, 48, 0.55)'
  ctx.shadowBlur = 18
  drawFittedText(ctx, member.realName, POSTER_WIDTH / 2, 962, 840, 700, 88, '#fffaf2')
  ctx.restore()

  const team = member.teamName || member.groupName
  if (team)
    drawFittedText(ctx, team, POSTER_WIDTH / 2, 1020, 820, 400, 34, palette.goldSoft)

  // 生辰徽章：日期 + 今日生辰
  const badgeY = 1088
  const badgeText = `${birthdayStamp(entry)}   ${BADGE_LABEL}`
  ctx.font = `500 30px ${CN_FONT}`
  const badgeWidth = ctx.measureText(badgeText).width + 68
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)'
  roundRect(ctx, (POSTER_WIDTH - badgeWidth) / 2, badgeY - 38, badgeWidth, 58, 29)
  ctx.fill()
  ctx.strokeStyle = palette.gold
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = palette.goldSoft
  ctx.textAlign = 'center'
  ctx.fillText(badgeText, POSTER_WIDTH / 2, badgeY)

  // 祝福语：两行以内都能落在画框内
  drawWrappedText(ctx, wish, POSTER_WIDTH / 2, 1160, 720, 50)

  // 底部装饰：礼物盒 + 蛋糕
  drawGift(ctx, 178, 1274, 68, palette.pink, palette.goldSoft)
  drawGift(ctx, 902, 1274, 68, palette.lilac, palette.goldSoft)
  drawCake(ctx, POSTER_WIDTH / 2, 1316, palette)

  ctx.font = `400 26px ${CN_FONT}`
  ctx.fillStyle = 'rgba(255, 248, 235, 0.66)'
  ctx.textAlign = 'center'
  ctx.fillText(`Desktop48 · 与你一起庆祝 · ${dayjs(today).format('YYYY')}`, POSTER_WIDTH / 2, 1374)

  const dataUrl = canvas.toDataURL('image/png')
  return { dataUrl, blob: pngDataUrlToBlob(dataUrl) }
}
