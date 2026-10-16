/**
 * 远程图片落盘（渲染层链路）：fetch → blob → `<a download>` → Chromium 下载到系统下载目录。
 *
 * 为什么不走主进程 netRequest：它只把响应体按 utf8 解码返回（且有 32MB 上限），二进制会被毁掉；
 * 新开一条二进制 IPC 通道要动 preload/契约/注册/测试四处。实测图片域 source.48.cn 返回
 * `Access-Control-Allow-Origin: *`，渲染层 fetch 不被 CORS 挡，故先用这条零 IPC 的路。
 * 代价：无「另存为」对话框；若接口哪天改发到不带 CORS 头的域，这里会 reject，由调用方提示。
 */

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

/**
 * 从 URL 与响应 content-type 推文件名。
 * URL 常带 query（?x-oss-process=... 之类），只认 pathname 的末段；
 * 无末段（以 / 结尾）或整串解析失败时退化为时间戳名。
 */
export function pickFileName(url: string, contentType = ''): string {
  let base = ''
  try {
    const { pathname } = new URL(url)
    base = sanitize(decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)))
  }
  catch {
    base = ''
  }
  const ext = EXT_BY_MIME[contentType.split(';')[0].trim().toLowerCase()] ?? ''
  if (!base)
    return `image-${Date.now()}${ext ? `.${ext}` : ''}`
  // 已带扩展名就尊重原样（服务端给的后缀比 content-type 更贴近用户预期）
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(base))
    return `${base}.${ext}`
  return base
}

/**
 * 下载一张远程图片，返回最终落盘用的文件名（供提示文案）。
 * 失败（网络、CORS、非 2xx）一律 reject，由调用方决定怎么告诉用户。
 */
export async function downloadImage(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  const name = pickFileName(url, blob.type || res.headers.get('content-type') || '')

  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 不能立刻 revoke：Chromium 是异步取 blob 的，同步回收会让下载静默失败
  setTimeout(() => URL.revokeObjectURL(href), 2000)
  return name
}
