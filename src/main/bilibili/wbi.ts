/**
 * B 站 WBI 签名。
 *
 * getDanmuInfo 不带 w_rid 直接被拒（code -352）；协议未公开、任何一步对不上都是静默风控，
 * 故整条链路拆成纯函数。
 */
import { createHash } from 'node:crypto'

/** wbi 口令重排表（B 站前端同一张表，非项目自有常量） */
const MIXIN_KEY_TABLE = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
]

/** 签名前要从参数值里剔除的字符，与 B 站前端一致，不剔会造成签名不一致 */
const STRIPPED_VALUE_CHARS = /[!'()*]/g

/** 取 URL 最后一段并去掉扩展名（wbi_img 的两段 key 就藏在这里） */
function filenameKey(url: string): string {
  const lastSegment = url.split('/').pop() ?? ''
  return lastSegment.split('.')[0]
}

/** 由 nav 接口的 img_url / sub_url 推出 32 位签名口令 */
export function buildWbiKey(imgUrl: string, subUrl: string): string {
  const shuffled = filenameKey(imgUrl) + filenameKey(subUrl)
  return MIXIN_KEY_TABLE.map(index => shuffled[index] ?? '').join('')
}

/**
 * 生成带 wts 与 w_rid 的查询串（不含 `?`）。签名串是「键升序 urlencode + 口令」的 md5；
 * 编码对齐 Python quote_plus（空格转 `+`），值里 `!'()*` 已剔除故两者差异集为空。
 */
export function buildWbiQuery(
  params: Record<string, string | number>,
  wbiKey: string,
  wts: number,
): string {
  const signed: Record<string, string> = {}
  for (const key of Object.keys(params))
    signed[key] = String(params[key]).replace(STRIPPED_VALUE_CHARS, '')
  // wts 最后写：时戳必须由调用方给定，同名业务参数不得把它顶掉
  signed.wts = String(wts)

  const query = Object.keys(signed)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(signed[key]).replace(/%20/g, '+')}`)
    .join('&')

  const wRid = createHash('md5').update(`${query}${wbiKey}`).digest('hex')
  return `${query}&w_rid=${wRid}`
}
