/**
 * 远程图片落盘（渲染层链路）：fetch → blob → `<a download>` → Chromium 下载到系统下载目录。
 *
 * 走渲染层 fetch：主进程 netRequest 按 utf8 解码会毁掉二进制；依赖图片域的 CORS 头，
 * 若接口改发到不带 CORS 头的域会 reject，由调用方提示。代价：无「另存为」对话框。
 */
import { pickFileName } from '@common/image-download'

export { buildAlbumFileName, isSmallImage, pickFileExtension, pickFileName, SMALL_IMAGE_MIN_SIDE } from '@common/image-download'

interface FetchedImage {
  blob: Blob
  name: string
}

async function fetchImage(url: string): Promise<FetchedImage> {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  return { blob, name: pickFileName(url, blob.type || res.headers.get('content-type') || '') }
}

function saveFetchedImage(image: FetchedImage): void {
  const href = URL.createObjectURL(image.blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = image.name
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 不能立刻 revoke：Chromium 是异步取 blob 的，同步回收会让下载静默失败
  setTimeout(() => URL.revokeObjectURL(href), 2000)
}

/**
 * 下载一张远程图片，返回最终落盘用的文件名（供提示文案）。
 * 失败（网络、CORS、非 2xx）一律 reject，由调用方决定怎么告诉用户。
 */
export async function downloadImage(url: string): Promise<string> {
  const image = await fetchImage(url)
  saveFetchedImage(image)
  return image.name
}
