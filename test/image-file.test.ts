import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodePngDataUrl, ensurePngExtension, safePngFileName } from '../src/main/image-file'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const IHDR = Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
const VALID_PNG = Buffer.concat([SIGNATURE, IHDR, Buffer.alloc(17), IEND])

function pngDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString('base64')}`
}

const BAD_URL = '图片数据格式不正确'

describe('decodePngDataUrl（写盘/剪贴板前的内容收窄）', () => {
  it('结构完整的 PNG 原样解出', () => {
    expect(decodePngDataUrl(pngDataUrl(VALID_PNG)).equals(VALID_PNG)).toBe(true)
  })

  it('非 PNG 前缀与任意字节都拒绝', () => {
    expect(() => decodePngDataUrl(`data:image/jpeg;base64,${VALID_PNG.toString('base64')}`)).toThrow(BAD_URL)
    expect(() => decodePngDataUrl(`data:image/png;base64,${Buffer.from('#!/bin/sh\necho pwned').toString('base64')}`)).toThrow(BAD_URL)
  })

  it('签名、IHDR、IEND 缺一不可', () => {
    expect(() => decodePngDataUrl(pngDataUrl(Buffer.concat([IHDR, Buffer.alloc(17), IEND])))).toThrow(BAD_URL)
    expect(() => decodePngDataUrl(pngDataUrl(Buffer.concat([SIGNATURE, IHDR, Buffer.alloc(17)])))).toThrow(BAD_URL)
    expect(() => decodePngDataUrl(pngDataUrl(Buffer.concat([SIGNATURE, Buffer.alloc(17), IEND])))).toThrow(BAD_URL)
  })

  it('base64 必须规范：空载荷、中间 padding、长度非 4 倍数、超上限', () => {
    expect(() => decodePngDataUrl('data:image/png;base64,')).toThrow(BAD_URL)
    expect(() => decodePngDataUrl('data:image/png;base64,QU=JD')).toThrow(BAD_URL)
    expect(() => decodePngDataUrl('data:image/png;base64,AAAAA')).toThrow(BAD_URL)
    expect(() => decodePngDataUrl(`data:image/png;base64,${'A'.repeat(16 * 1024 * 1024 + 4)}`)).toThrow(BAD_URL)
  })

  it('非字符串入参拒绝而不是抛 TypeError', () => {
    for (const value of [null, undefined, 123, {}]) {
      expect(() => decodePngDataUrl(value as unknown as string)).toThrow(BAD_URL)
    }
  })
})

describe('ensurePngExtension（落盘路径强制 .png）', () => {
  it('已有后缀保持，大小写不敏感', () => {
    expect(ensurePngExtension('/Pictures/card.png')).toBe('/Pictures/card.png')
    expect(ensurePngExtension('/Pictures/card.PNG')).toBe('/Pictures/card.PNG')
  })

  it('无后缀或别的后缀一律追加 .png', () => {
    expect(ensurePngExtension('/Pictures/card')).toBe('/Pictures/card.png')
    expect(ensurePngExtension('/Pictures/evil.sh')).toBe('/Pictures/evil.sh.png')
  })
})

describe('safePngFileName（对话框默认名）', () => {
  it('剥掉目录并替换非法字符，同时补后缀', () => {
    expect(safePngFileName('../evil/小 测:试.png')).toBe('小_测_试.png')
    expect(safePngFileName('../evil/card')).toBe('card.png')
    expect(safePngFileName('..\\..\\evil.sh')).toBe('.._.._evil.sh.png')
  })

  it('纯点号、空值与非字符串一律回落到默认名', () => {
    expect(safePngFileName('..')).toBe('birthday-card.png')
    expect(safePngFileName('')).toBe('birthday-card.png')
    expect(safePngFileName(null as unknown as string)).toBe('birthday-card.png')
    expect(safePngFileName(123 as unknown as string)).toBe('birthday-card.png')
  })
})
