// 图片写入剪贴板 / 磁盘前的收窄：渲染层传来的 data URL 与文件名都不当可信输入。

import { Buffer } from 'node:buffer'
import path from 'node:path'

const PNG_DATA_URL_REGEX = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/
const PNG_DATA_URL_MAX_CHARS = 16 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const PNG_IHDR_PREFIX = Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])

/** 只接受结构完整的 PNG：签名 + IHDR 开头 + IEND 收尾，避免任意字节被当图片写出 */
export function decodePngDataUrl(dataUrl: string): Buffer {
  const match = typeof dataUrl === 'string' ? PNG_DATA_URL_REGEX.exec(dataUrl) : null
  if (!match || match[1].length > PNG_DATA_URL_MAX_CHARS || match[1].length % 4 !== 0)
    throw new Error('图片数据格式不正确')
  const buffer = Buffer.from(match[1], 'base64')
  const signatureEnd = PNG_SIGNATURE.length
  if (buffer.length < signatureEnd + PNG_IHDR_PREFIX.length + PNG_IEND.length
    || !buffer.subarray(0, signatureEnd).equals(PNG_SIGNATURE)
    || !buffer.subarray(signatureEnd, signatureEnd + PNG_IHDR_PREFIX.length).equals(PNG_IHDR_PREFIX)
    || !buffer.subarray(-PNG_IEND.length).equals(PNG_IEND)) {
    throw new Error('图片数据格式不正确')
  }
  return buffer
}

/** 文件名一律以 .png 结尾：保存对话框的 filters 只是 UI 提示，用户仍可输入任意后缀 */
export function ensurePngExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith('.png') ? filePath : `${filePath}.png`
}

/** 建议名只作对话框默认值：剥目录 + 白名单替换（比 common 的 sanitizeFileName 更严，渲染层输入不可信）+ 补后缀 */
export function safePngFileName(suggestedName: string): string {
  const base = path.basename(typeof suggestedName === 'string' ? suggestedName : '')
  const cleaned = base.replace(/[^\w\u4E00-\u9FA5.-]/g, '_')
  return /^\.*$/.test(cleaned) ? 'birthday-card.png' : ensurePngExtension(cleaned)
}
