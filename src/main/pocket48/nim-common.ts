/**
 * 网易云信 commonlink 私有协议共用原语：varint / 属性表 / 帧编解码 / RC4 / RSA 握手。
 * 聊天室（nim-chatroom.ts，直播弹幕）与圈组 QChat（nim-qchat.ts，房间消息）两个协议族
 * 共用这一层，各自只保留自己的服务号、登录包与帧语义。
 */
import { Buffer } from 'node:buffer'
import { createPublicKey, publicEncrypt } from 'node:crypto'
import zlib from 'node:zlib'

/** 握手 RSA 公钥（SPKI DER，base64）与密钥版本：两个协议族同一把 */
const RSA_PUBLIC_KEY_DER
  = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCBxLuL8+xpQSddSnSvPkvNOHdcr5Euqw+kkOSzO/buDMheCfFILRC/v5+nv8BsL7/YZWVpDA8sIBTxfNRqSCu0uLjlbJqT/sMnPT1xxdQrkb1HSnuSyTbZbqaInQ13tBE2SfcAhsQZJJ1hKQSE2QyKOMxQPhP583qcsIhDbdExvwIDAQAB'
const RSA_KEY_VERSION = 0

// ===== varint 与属性表编解码 =====

export function encodeVarint(value: number): Buffer {
  let rest = value >>> 0
  const bytes: number[] = []
  do {
    let byte = rest & 0x7F
    rest = Math.floor(rest / 128)
    if (rest)
      byte |= 0x80
    bytes.push(byte)
  } while (rest)
  return Buffer.from(bytes)
}

export interface Varint {
  value: number
  size: number
}

export function readVarint(buffer: Buffer, offset = 0): Varint | null {
  let value = 0
  let scale = 1
  for (let index = offset; index < buffer.length && index < offset + 5; index++) {
    const byte = buffer[index]
    value += (byte & 0x7F) * scale
    if ((byte & 0x80) === 0)
      return { value, size: index - offset + 1 }
    scale *= 128
  }
  return null
}

export function encodeBytes(value: string | number | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return Buffer.concat([encodeVarint(bytes.length), bytes])
}

/** 属性表编码：按 key 升序，跳过空值 */
export function encodeProperties(input: Record<number, string | number | Buffer>): Buffer {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [Number(key), value] as const)
    .sort(([left], [right]) => left - right)
  const chunks: Buffer[] = [encodeVarint(entries.length)]
  for (const [key, value] of entries) {
    chunks.push(encodeVarint(key), encodeBytes(value))
  }
  return Buffer.concat(chunks)
}

export function decodeProperties(body: Buffer): Map<number, Buffer> {
  const count = readVarint(body)
  if (!count)
    throw new Error('属性表不完整')
  let offset = count.size
  const properties = new Map<number, Buffer>()
  for (let index = 0; index < count.value; index++) {
    const key = readVarint(body, offset)
    const length = key ? readVarint(body, offset + key.size) : null
    if (!key || !length)
      throw new Error('属性表条目不完整')
    offset += key.size + length.size
    if (offset + length.value > body.length)
      throw new Error('属性表内容越界')
    properties.set(key.value, body.subarray(offset, offset + length.value))
    offset += length.value
  }
  return properties
}

export function text(buffer: Buffer | undefined): string {
  return (buffer || Buffer.alloc(0)).toString('utf8').trim()
}

// ===== 帧编解码 =====

export interface WirePacket {
  serviceId: number
  commandId: number
  serial: number
  resultCode: number
  body: Buffer
}

const EMPTY_BODY = Buffer.alloc(0)

export function makePacket(serviceId: number, commandId: number, serial: number, body: Buffer = EMPTY_BODY, tag = 0): Buffer {
  const header = Buffer.allocUnsafe(5)
  header[0] = serviceId
  header[1] = commandId
  header.writeInt16LE(serial, 2)
  header[4] = tag
  return Buffer.concat([encodeVarint(header.length + body.length), header, body])
}

export function decodePacket(raw: Buffer, embedded = false): WirePacket {
  const frameLength = readVarint(raw)
  if (!frameLength || raw.length < frameLength.size + 5 || (!embedded && frameLength.value < 5))
    throw new Error('数据帧不完整')
  let offset = frameLength.size
  const serviceId = raw[offset]
  const commandId = raw[offset + 1]
  const serial = raw.readInt16LE(offset + 2)
  const tag = raw[offset + 4]
  offset += 5

  let resultCode = 200
  if (tag & 2) {
    if (offset + 2 > raw.length)
      throw new Error('响应状态不完整')
    resultCode = raw.readInt16LE(offset)
    offset += 2
  }

  const end = embedded ? raw.length : Math.min(raw.length, frameLength.size + frameLength.value)
  let body = raw.subarray(offset, end)
  if (tag & 1) {
    if (body.length < 4)
      throw new Error('压缩帧不完整')
    const expectedLength = body.readInt32LE(0)
    body = zlib.inflateSync(body.subarray(4))
    if (body.length !== expectedLength)
      throw new Error('压缩帧长度不一致')
  }
  return { serviceId, commandId, serial, resultCode, body }
}

/** 上行合并帧（service 4）内嵌真实数据包：跳过前 8 字节后解出，解不出返回 null */
export function decodeEmbeddedPacket(raw: Buffer): WirePacket | null {
  const length = readVarint(raw)
  if (!length || raw.length < length.size + 5)
    return null
  return decodePacket(raw, true)
}

// ===== RC4 流加密（收发各持独立状态实例） =====

export class Rc4Stream {
  private state = Uint8Array.from({ length: 256 }, (_, index) => index)
  private x = 0
  private y = 0

  constructor(key: Buffer) {
    if (!key.length)
      throw new Error('加密密钥为空')
    let cursor = 0
    for (let index = 0; index < 256; index++) {
      cursor = (cursor + this.state[index] + key[index % key.length]) & 0xFF
      const swapped = this.state[index]
      this.state[index] = this.state[cursor]
      this.state[cursor] = swapped
    }
  }

  apply(input: Buffer): Buffer {
    const output = Buffer.allocUnsafe(input.length)
    for (let index = 0; index < input.length; index++) {
      this.x = (this.x + 1) & 0xFF
      this.y = (this.y + this.state[this.x]) & 0xFF
      const swapped = this.state[this.x]
      this.state[this.x] = this.state[this.y]
      this.state[this.y] = swapped
      output[index] = input[index] ^ this.state[(this.state[this.x] + this.state[this.y]) & 0xFF]
    }
    return output
  }
}

// ===== 握手 =====

/**
 * 握手包：i32LE(密钥版本) + RSA 分块加密的 [varint(len)+RC4密钥 + 登录包]。
 * 两个协议族的握手载荷结构一致，差别只在调用方传入的登录包。
 */
export function makeHandshake(key: Buffer, loginPacket: Buffer): Buffer {
  const publicKey = createPublicKey({
    key: Buffer.from(RSA_PUBLIC_KEY_DER, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const payload = Buffer.concat([encodeBytes(key), loginPacket])
  const blocks: Buffer[] = []
  for (let offset = 0; offset < payload.length; offset += 117) {
    blocks.push(publicEncrypt({
      key: publicKey,
      padding: 1, // RSA_PKCS1_PADDING
    }, payload.subarray(offset, offset + 117)))
  }
  const version = Buffer.allocUnsafe(4)
  version.writeInt32LE(RSA_KEY_VERSION)
  return makePacket(1, 1, 0, Buffer.concat([version, ...blocks]))
}
