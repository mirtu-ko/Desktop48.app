import type { DanmakuOverlayEntry } from '@renderer/composables/use-danmaku-overlay'
import { useDanmakuOverlay } from '@renderer/composables/use-danmaku-overlay'
import Apis from '@renderer/services/apis'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed, ref, shallowRef } from 'vue'

/** Tools.lyricsParse 的输出形态：[hh:mm:ss]\t用户名\t内容 */
interface RawLyricLine {
  time: string
  username?: string
  content?: string
}

/**
 * 录播弹幕编排：收敛弹幕数据源与叠加层引擎的唯一入口。
 * 加载并解析 url 对应的弹幕（预计算秒数、排序），叠加层按播放进度追加到可见堆叠、逾期挤出。
 * 播放推进只走 onTimeUpdate，seek/重播只走 seekBarragesTo。
 */
export function usePlaybackDanmaku(options: {
  /** 当前媒体元素（video/audio），ensureBarragesLoaded 读进度 */
  getMedia: () => HTMLMediaElement | null
}) {
  // 播放进度（秒）：MiniControls 进度条与弹幕游标的共同基准
  const currentTime = ref(0)
  const barrageUrl = ref('')
  // 是否有弹幕数据源：无弹幕时隐藏弹幕叠加层
  const hasBarrage = computed(() => !!barrageUrl.value)

  // 弹幕唯一数据源（按 seconds 升序），与加载标记
  const barrageEntries = shallowRef<DanmakuOverlayEntry[]>([])
  const barrageLoaded = shallowRef(false)
  let loadedUrl = ''

  /** 加载并解析指定 url 的弹幕；url 未变化时跳过 */
  async function loadBarrages(url: string) {
    if (!url || loadedUrl === url)
      return
    try {
      const response = await Apis.barrage(url)
      const lines: RawLyricLine[] = Tools.lyricsParse(response)
      barrageEntries.value = lines
        .map(item => ({
          seconds: Tools.timeToSecond(item.time),
          content: item.content ?? '',
          username: item.username ?? '',
        }))
        // 空内容在堆叠里不可见、在「全部」面板里只是空白行；时间解析失败（NaN）会让二分游标卡死，
        // 两者都在解析阶段丢掉
        .filter(item => item.content && Number.isFinite(item.seconds))
        .sort((a, b) => a.seconds - b.seconds)
      // 解析成功才标记已加载：否则一次解析异常会被当成「已加载」而不再重试
      loadedUrl = url
      barrageLoaded.value = true
    }
    catch (error) {
      console.error('[use-playback-danmaku] 弹幕加载失败:', error)
      ElMessage({ message: '弹幕加载失败', type: 'error' })
    }
  }

  // 弹幕叠加层引擎（左下角玻璃条）
  const {
    items: danmakuOverlayItems,
    advanceTo: advanceOverlayTo,
    seekTo: seekOverlayTo,
  } = useDanmakuOverlay({
    getEntries: () => barrageEntries.value,
  })

  /** seek / 重播统一入口：叠加层游标二分定位 */
  function seekBarragesTo(time: number) {
    seekOverlayTo(time)
    currentTime.value = time
  }

  /** 播放推进：timeupdate 唯一入口 */
  function onTimeUpdate(newTime: number) {
    currentTime.value = newTime
    advanceOverlayTo(newTime)
  }

  /** 弹幕晚于播放到达时，按当前进度补齐叠加层（跳转后从目标进度继续） */
  async function ensureBarragesLoaded() {
    await loadBarrages(barrageUrl.value)
    seekBarragesTo(options.getMedia()?.currentTime ?? 0)
  }

  /** 弹幕数据源变化（换回放）：清空叠加层、进度归零并重置加载态 */
  function resetBarrageSource() {
    barrageEntries.value = []
    barrageLoaded.value = false
    loadedUrl = ''
    seekBarragesTo(0)
  }

  return {
    currentTime,
    barrageUrl,
    hasBarrage,
    barrageLoaded,
    barrageEntries,
    danmakuOverlayItems,
    seekBarragesTo,
    onTimeUpdate,
    ensureBarragesLoaded,
    resetBarrageSource,
  }
}
