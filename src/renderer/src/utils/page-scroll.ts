/**
 * 页面主滚动容器的定位与回顶。
 *
 * 主内容区里各页的主 el-scrollbar 统一标记 scrollbar-wrapper，当前可见的那个即「本页滚动容器」——
 * keep-alive 分离的旧页面、v-show 隐藏的分支都取不到 clientRects，天然被排除。
 * 显隐判定（BackTopButton）与 Dock 双击回顶共用这一份口径，别再各自写一遍选择器。
 * 放不进 utils/tools.ts：Tools 的契约是「不依赖 DOM」。
 */

/** 主内容区节点：挂载后恒定，页面层重建导致断开时才重新查一次 */
let appContent: HTMLElement | null = null

function getAppContent(): HTMLElement | null {
  if (!appContent?.isConnected)
    appContent = document.querySelector<HTMLElement>('.app-content')
  return appContent
}

/** 元素当前是否真实渲染（keep-alive 分离 / v-show 隐藏的分支要排除） */
function isRendered(el: HTMLElement): boolean {
  return el.getClientRects().length > 0
}

/** 是否为本页主滚动容器（主内容区自身也算，无 el-scrollbar 的页面回落到它） */
export function isPageScroller(el: HTMLElement): boolean {
  const content = getAppContent()
  if (!content)
    return false
  return el === content
    || (content.contains(el) && el.matches('.el-scrollbar__wrap') && !!el.closest('.scrollbar-wrapper'))
}

/** 本页主滚动容器（取第一个可见的；定位不到时回落到主内容区自身） */
export function resolvePageScroller(): HTMLElement | null {
  const content = getAppContent()
  if (!content)
    return null
  for (const wrap of content.querySelectorAll<HTMLElement>('.el-scrollbar__wrap')) {
    if (isRendered(wrap) && wrap.closest('.scrollbar-wrapper'))
      return wrap
  }
  return content
}

/** 本页平滑回到顶部 */
export function scrollPageToTop(): void {
  resolvePageScroller()?.scrollTo({ top: 0, behavior: 'smooth' })
}
