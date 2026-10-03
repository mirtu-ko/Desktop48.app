import { computed } from 'vue'

/** 视频实际渲染区（去 letterbox 黑边）在容器内的矩形；元数据未就绪时为 null */
interface DanmakuLayerRect {
  left: number
  height: number
  bottom: number
}

// 弹幕字号随画面渲染高度等比缩放的系数（写死 px 在大画面里偏小）
const FONT_RATIO = 0.027
// 弹幕条距画面左 / 下边的内缩量
const MARGIN = 12
// bottom 下限：避开底部控制条
const MIN_BOTTOM = 46

/**
 * 弹幕层的字号与定位，直播与回放共用。
 * 锚视频实际渲染区左下角而非容器左下角：全屏下竖屏视频左右是黑边，锚容器会让气泡离画面太远。
 */
export function useDanmakuLayer(options: {
  videoRect: () => DanmakuLayerRect | null
  compact: () => boolean
}) {
  const { videoRect, compact } = options

  // 字号上下限按窗口形态区分：窄浮窗 10~14px，主窗 / 全屏 12~20px
  const fontSize = computed(() => {
    const [min, max] = compact() ? [10, 14] : [12, 20]
    return Math.min(max, Math.max(min, Math.round((videoRect()?.height ?? 0) * FONT_RATIO)))
  })

  const position = computed(() => {
    const rect = videoRect()
    if (!rect)
      return { left: `${MARGIN}px`, bottom: `${MIN_BOTTOM}px` }

    return {
      left: `${(rect.left + MARGIN).toFixed(1)}px`,
      bottom: `${Math.max(MIN_BOTTOM, rect.bottom + MARGIN).toFixed(1)}px`,
    }
  })

  return { fontSize, position }
}
