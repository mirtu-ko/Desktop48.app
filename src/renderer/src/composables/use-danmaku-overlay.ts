import type { Ref } from 'vue'
import { computed, shallowRef } from 'vue'

/** 弹幕投放所需的最小字段：seconds 为解析时预计算的播放时刻（已排序） */
export interface DanmakuOverlayEntry {
  seconds: number
  content: string
}

/** 弹幕显示设置（与宿主组件共享的 reactive 对象的只读视角） */
export interface DanmakuOverlaySettings {
  enabled: boolean
  fontSize: number
  speed: number
  /** 弹幕可占用的高度比例，1 表示铺满 */
  area: number
}

export interface DanmakuOverlayItem {
  id: number
  content: string
  track: number
  // 该弹幕左边缘与容器右边缘重合的播放时刻，位置由 currentTime 反推
  bornAt: number
  width: number
  // 本条弹幕完全离开屏幕的播放时刻，用于回收与轨道复用判定
  leaveAt: number
  // 出生时的容器宽度，即左边缘起点
  startX: number
  // 逐条记录速度，改设置时已在飞的弹幕仍按原速走完，不会突然错位
  speed: number
  trackHeight: number
}

interface UseDanmakuOverlayOptions {
  /** 视频容器：轨道区域按它的宽高计算 */
  videoBoxRef: Ref<HTMLElement | null>
  /** 当前媒体元素（video/audio），用于逐帧取播放进度 */
  getMedia: () => HTMLMediaElement | null
  /** 全量弹幕数据源（按 seconds 升序） */
  getEntries: () => DanmakuOverlayEntry[]
  settings: DanmakuOverlaySettings
}

const DANMAKU_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", sans-serif'
// 底部避让区：MiniControls 自绘胶囊约 34px 高 + 距底 12px，轨道区域避开约 48px，防止遮挡
const CONTROLS_RESERVED_HEIGHT = 48

/** 二分查找第一条 seconds >= target 的弹幕下标（列表须已按 seconds 升序） */
export function findBarrageIndex(entries: Array<{ seconds: number }>, target: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (entries[mid].seconds < target)
      low = mid + 1
    else
      high = mid
  }
  return low
}

/**
 * 视频弹幕叠加层引擎：位置不由逐帧累加，而是按播放进度反推
 * x = 容器宽度 - (currentTime - bornAt) * speed，
 * 暂停、缓冲、倍速、seek 都会自动同步，无需额外处理。
 * 渲染循环直接改 DOM transform，绕过响应式逐帧 patch。
 */
export function useDanmakuOverlay(options: UseDanmakuOverlayOptions) {
  const { videoBoxRef, getMedia, getEntries, settings } = options

  const items = shallowRef<DanmakuOverlayItem[]>([])
  // 指向 getEntries() 的游标：spawnUpTo 推进、seekTo 二分重置
  let cursor = 0
  let nextId = 0
  let animFrameId: number | null = null
  // id -> DOM 节点，渲染循环直接改 transform
  const nodes = new Map<number, HTMLElement>()
  // 每条轨道上最后一条弹幕，用于追尾判定
  const trackTails: (DanmakuOverlayItem | null)[] = []
  let textMeasureCtx: CanvasRenderingContext2D | null = null

  const trackHeight = computed(() => Math.round(settings.fontSize * 1.6))

  function measureTextWidth(text: string): number {
    if (!textMeasureCtx) {
      const canvas = document.createElement('canvas')
      textMeasureCtx = canvas.getContext('2d')
    }
    if (!textMeasureCtx)
      return text.length * settings.fontSize

    // 每次测量都同步字体，字号设置变化后宽度才准
    textMeasureCtx.font = `${settings.fontSize}px ${DANMAKU_FONT_FAMILY}`
    return textMeasureCtx.measureText(text).width
  }

  function getMaxTracks(): number {
    const height = (videoBoxRef.value?.clientHeight || 0) - CONTROLS_RESERVED_HEIGHT
    if (height <= 0)
      return 0
    return Math.max(0, Math.floor((height * settings.area - 10) / trackHeight.value))
  }

  // 给定播放时刻下弹幕左边缘的坐标
  function danmakuLeft(item: DanmakuOverlayItem, time: number): number {
    return item.startX - (time - item.bornAt) * item.speed
  }

  // 轨道可复用的条件：尾部弹幕的右边缘已经越过新弹幕的左边缘，否则两者会重叠
  function findAvailableTrack(now: number, newLeft: number): number {
    const maxTracks = getMaxTracks()
    for (let i = 0; i < maxTracks; i++) {
      const tail = trackTails[i]
      if (!tail || tail.leaveAt <= now)
        return i

      if (danmakuLeft(tail, now) + tail.width <= newLeft)
        return i
    }
    return -1
  }

  function spawn(entry: DanmakuOverlayEntry, now: number) {
    const containerWidth = videoBoxRef.value?.clientWidth || 0
    if (containerWidth <= 0)
      return

    const text = entry.content || ''
    if (!text)
      return

    const textWidth = measureTextWidth(text) + 20
    const speed = settings.speed
    // 以弹幕自身时间戳为起点，而非 timeupdate 的回调时刻，
    // 这样同一个 250ms 回调窗口内的弹幕会按真实时间自然错开而不是挤在一起。
    const bornAt = entry.seconds
    const newLeft = containerWidth - (now - bornAt) * speed
    const track = findAvailableTrack(now, newLeft)
    if (track < 0)
      return

    const item: DanmakuOverlayItem = {
      id: nextId++,
      content: text,
      track,
      bornAt,
      width: textWidth,
      leaveAt: bornAt + (containerWidth + textWidth) / speed,
      startX: containerWidth,
      speed,
      trackHeight: trackHeight.value,
    }
    trackTails[track] = item
    items.value = [...items.value, item]
  }

  /** 把 seconds <= time 的弹幕投放到叠加层；关闭期间只推进游标，重新打开不会倒灌历史弹幕 */
  function spawnUpTo(time: number) {
    const list = getEntries()
    if (!settings.enabled) {
      cursor = findBarrageIndex(list, time)
      return
    }
    while (cursor < list.length && list[cursor].seconds <= time) {
      spawn(list[cursor], time)
      cursor++
    }
  }

  function clear() {
    items.value = []
    trackTails.length = 0
    nodes.clear()
  }

  /** seek / 重播统一入口：清空在飞弹幕并把游标二分定位到目标时刻 */
  function seekTo(time: number) {
    clear()
    cursor = findBarrageIndex(getEntries(), time)
  }

  /** 模板函数 ref：挂载当帧先摆到正确位置，避免在左上角闪一下 */
  function setNode(item: DanmakuOverlayItem, el: HTMLElement | null) {
    if (!el) {
      nodes.delete(item.id)
      return
    }
    nodes.set(item.id, el)
    const media = getMedia()
    el.style.transform = `translate(${danmakuLeft(item, media ? media.currentTime : 0)}px, ${item.track * item.trackHeight + 4}px)`
  }

  /** 渲染循环只做两件事：按播放进度回收离屏弹幕、把位置写进 DOM */
  function start() {
    const loop = () => {
      const media = getMedia()
      const now = media ? media.currentTime : 0
      const current = items.value

      if (current.length > 0) {
        const remaining: DanmakuOverlayItem[] = []
        for (const item of current) {
          if (item.leaveAt <= now) {
            if (trackTails[item.track] === item)
              trackTails[item.track] = null
            nodes.delete(item.id)
            continue
          }
          remaining.push(item)
          const node = nodes.get(item.id)
          if (node)
            node.style.transform = `translate(${danmakuLeft(item, now)}px, ${item.track * item.trackHeight + 4}px)`
        }
        if (remaining.length !== current.length)
          items.value = remaining
      }

      animFrameId = requestAnimationFrame(loop)
    }
    animFrameId = requestAnimationFrame(loop)
  }

  function stop() {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId)
      animFrameId = null
    }
  }

  return { items, setNode, spawnUpTo, seekTo, clear, start, stop }
}
