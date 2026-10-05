/**
 * B 站直播弹幕的二进制包协议（web 端 /sub 长连接）。全部纯函数，不碰网络 / IPC / 日志。
 * 协议未公开且变过版，故拆包与字段提取单独隔离，变更时只改这里。
 */
import type { DanmakuEmote, DanmakuEmoteMap, LiveDanmaku } from '../../common/live-danmaku'
import { Buffer } from 'node:buffer'
import { brotliDecompressSync, inflateSync } from 'node:zlib'

/** 包头固定长度：总长 u32 / 包头长 u16 / 协议版本 u16 / 操作码 u32 / 序号 u32 */
export const PACKET_HEADER_SIZE = 16

/** 操作码：本项目只发心跳与鉴权、只收消息 */
export const DANMAKU_OP_HEARTBEAT = 2
export const DANMAKU_OP_MESSAGE = 5
export const DANMAKU_OP_AUTH = 7

/** 心跳包正文是这段固定字符串（不是 JSON，服务端只做非空校验） */
export const DANMAKU_HEARTBEAT_BODY = '[object Object]'

/** 鉴权时请求的协议版本：3 = 正文为 brotli 压缩 */
export const DANMAKU_PROTOVER = 3

/** 压缩正文的协议版本 */
const DEFLATE_PROTOVER = 2
const BROTLI_PROTOVER = 3

/** 拆出的单个包；body 仅在 op=Message 且正文是 JSON 时非空 */
export interface DanmakuPacket {
  op: number
  body: unknown
}

/** 组装一个发往服务端的包（正文恒为未压缩的 JSON 文本） */
export function packDanmakuPacket(body: string, op: number): Buffer {
  const bodyBuffer = Buffer.from(body, 'utf8')
  const header = Buffer.alloc(PACKET_HEADER_SIZE)
  header.writeUInt32BE(PACKET_HEADER_SIZE + bodyBuffer.length, 0)
  header.writeUInt16BE(PACKET_HEADER_SIZE, 4)
  header.writeUInt16BE(1, 6)
  header.writeUInt32BE(op, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, bodyBuffer])
}

/** 鉴权包正文。uid 恒为 0（未登录）；buvid 必须非空，留空会被服务端降级到稀疏通道 */
export function buildDanmakuAuthBody(roomId: number, token: string, buvid: string): string {
  return JSON.stringify({
    uid: 0,
    roomid: roomId,
    protover: DANMAKU_PROTOVER,
    buvid,
    platform: 'web',
    type: 2,
    key: token,
  })
}

/** 拆出缓冲区里的全部包（含压缩包展开后的内层包） */
export function unpackDanmakuPackets(buffer: Buffer): DanmakuPacket[] {
  const packets: DanmakuPacket[] = []
  appendPackets(buffer, packets)
  return packets
}

/**
 * 一个 TCP 帧里可能拼着多个包，压缩包的正文里还嵌着一层包，故按包头长度循环 + 递归展开。
 * 长度字段不自洽（半包 / 脏数据）时立即停止：继续按错误偏移读会切出一串垃圾包。
 */
function appendPackets(buffer: Buffer, out: DanmakuPacket[]): void {
  let offset = 0
  while (offset + PACKET_HEADER_SIZE <= buffer.length) {
    const totalLength = buffer.readUInt32BE(offset)
    const headerLength = buffer.readUInt16BE(offset + 4)
    const protover = buffer.readUInt16BE(offset + 6)
    const op = buffer.readUInt32BE(offset + 8)
    if (
      headerLength < PACKET_HEADER_SIZE
      || totalLength < headerLength
      || offset + totalLength > buffer.length
    ) {
      return
    }

    const body = buffer.subarray(offset + headerLength, offset + totalLength)
    offset += totalLength

    if (protover === DEFLATE_PROTOVER || protover === BROTLI_PROTOVER) {
      const inflated = inflateBody(body, protover)
      if (inflated)
        appendPackets(inflated, out)
      continue
    }

    out.push({ op, body: op === DANMAKU_OP_MESSAGE ? parseJsonBody(body) : null })
  }
}

function inflateBody(body: Buffer, protover: number): Buffer | null {
  try {
    return protover === BROTLI_PROTOVER ? brotliDecompressSync(body) : inflateSync(body)
  }
  catch {
    return null
  }
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  }
  catch {
    return null
  }
}

/**
 * 从消息正文里取出弹幕；正文可能是单个对象或对象数组。
 * 非 DANMU_MSG 一律丢弃：进场 / 人气 / 榜单格式各异，部分还是 base64 protobuf。
 */
export function extractDanmakuList(payload: unknown): LiveDanmaku[] {
  const items = Array.isArray(payload) ? payload : [payload]
  const list: LiveDanmaku[] = []
  for (const item of items) {
    const danmaku = extractDanmaku(item)
    if (danmaku)
      list.push(danmaku)
  }
  return list
}

function extractDanmaku(item: unknown): LiveDanmaku | null {
  if (!item || typeof item !== 'object')
    return null
  const { cmd, info } = item as { cmd?: unknown, info?: unknown }
  // cmd 常带后缀（如 DANMU_MSG:4:0:2:2:2:0），比对冒号前的主指令名
  if (typeof cmd !== 'string' || cmd.split(':')[0] !== 'DANMU_MSG')
    return null
  if (!Array.isArray(info))
    return null

  const text = info[1]
  if (typeof text !== 'string' || !text)
    return null

  // info[2] = [uid, 用户名, ...]
  const sender = info[2]
  const username = Array.isArray(sender) && typeof sender[1] === 'string' ? sender[1] : ''
  const emots = extractEmotes(info[0], text)
  return emots ? { text, username, emots } : { text, username }
}

/** 表情尺寸缺省值：协议里恒为 20×20，字段缺失时按正方形兜底 */
const EMOTE_FALLBACK_SIZE = 20

/**
 * 取本条弹幕用到的表情。两个来源：普通表情在 info[0][15].extra 的 emots（键即占位符），
 * 粉丝装扮 / 大表情在 info[0][13]（单条，名字藏在 emoticon_unique 的方括号里）。
 * 取不到一律返回 undefined —— 渲染层据此保持纯文本，不做任何猜测。
 */
function extractEmotes(meta: unknown, content: string): DanmakuEmoteMap | undefined {
  if (!Array.isArray(meta))
    return undefined

  const emots: DanmakuEmoteMap = {}

  const extra = parseJsonObject((meta[15] as { extra?: unknown } | undefined)?.extra)
  const rawEmots = extra?.emots
  if (rawEmots && typeof rawEmots === 'object') {
    for (const [name, value] of Object.entries(rawEmots as Record<string, unknown>)) {
      const emote = toEmote(value)
      if (name && emote)
        emots[name] = emote
    }
  }

  const bulge = parseJsonObject(meta[13])
  const bulgeEmote = toEmote(bulge)
  if (bulgeEmote) {
    const unique = bulge?.emoticon_unique
    const key = (typeof unique === 'string' ? /\[[^\]]+\]/.exec(unique)?.[0] : undefined) ?? content
    if (key)
      emots[key] = bulgeEmote
  }

  return Object.keys(emots).length > 0 ? emots : undefined
}

/** 字段可能是对象，也可能是字符串化 JSON（B 站两种都下发过）；解析不出对象返回 null */
function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    }
    catch {
      return null
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function toEmote(value: unknown): DanmakuEmote | undefined {
  const raw = value as { url?: unknown, width?: unknown, height?: unknown } | null | undefined
  if (typeof raw?.url !== 'string' || !raw.url)
    return undefined
  // 协议下发的是 http，统一升级：渲染层在 file:// 下加载 http 图片会被混合内容拦
  return {
    url: raw.url.replace(/^http:\/\//, 'https://'),
    width: emoteSize(raw.width),
    height: emoteSize(raw.height),
  }
}

function emoteSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : EMOTE_FALLBACK_SIZE
}

/** 取正文里各条消息的主指令名（诊断用）：弹幕数对不上网页时，靠它分清「没发」与「没认」 */
export function listMessageCommands(payload: unknown): string[] {
  const items = Array.isArray(payload) ? payload : [payload]
  const names: string[] = []
  for (const item of items) {
    const cmd = (item as { cmd?: unknown } | null | undefined)?.cmd
    if (typeof cmd === 'string' && cmd)
      names.push(cmd.split(':')[0])
  }
  return names
}
