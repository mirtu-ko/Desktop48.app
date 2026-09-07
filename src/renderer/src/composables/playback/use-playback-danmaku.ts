import type { Ref } from 'vue'
import type { DanmakuSettings } from '../media/use-danmaku-settings'
import { computed, ref } from 'vue'
import { useBarrageList } from '../media/use-barrage-list'
import { useDanmakuOverlay } from '../media/use-danmaku-overlay'
import { useDanmakuSettings } from '../media/use-danmaku-settings'

/**
 * 录播弹幕编排：
 * 收敛三套进度游标（播放进度 currentTime、右侧列表游标、叠加层游标）的唯一入口——
 * 播放推进只走 onTimeUpdate，seek/重播只走 seekBarragesTo，
 * 任何一条路径都不可能漏同步（拆分前两者分散在组件两处，靠约定维持一致）。
 * 同时持有：弹幕数据源 url、右侧列表引擎、叠加层引擎、显示设置。
 */
export function usePlaybackDanmaku(options: {
  /** 视频容器：弹幕叠加层的轨道区域按它的宽高计算 */
  videoBoxRef: Ref<HTMLElement | null>
  /** 当前媒体元素（video/audio），叠加层逐帧取进度、ensureBarragesLoaded 读进度 */
  getMedia: () => HTMLMediaElement | null
}) {
  // 播放进度（秒）：MiniControls 进度条与弹幕游标的共同基准
  const currentTime = ref(0)
  const barrageUrl = ref('')
  // 是否有弹幕数据源：无弹幕时隐藏弹幕叠加层、右缘切换竖条与弹幕侧栏
  const hasBarrage = computed(() => !!barrageUrl.value)

  // 弹幕显示设置（localStorage 持久化见 use-danmaku-settings）
  const {
    settings,
    load: loadSettings,
    save: saveSettings,
  } = useDanmakuSettings()

  // 弹幕数据源与右侧列表游标
  const {
    entries: barrageEntries,
    items: barrageListItems,
    loaded: barrageLoaded,
    load: loadBarrages,
    buildUpTo: buildListUpTo,
    advanceTo: advanceListTo,
    reset: resetBarrageList,
  } = useBarrageList()

  // 弹幕叠加层引擎（渲染循环在 use-danmaku-overlay 内部）
  const {
    items: danmakuOverlayItems,
    setNode: setDanmakuNode,
    spawnUpTo: processOverlayDanmaku,
    seekTo: seekOverlayTo,
    clear: clearOverlay,
    start: startAnimation,
    stop: stopAnimation,
  } = useDanmakuOverlay({
    videoBoxRef: options.videoBoxRef,
    getMedia: options.getMedia,
    getEntries: () => barrageEntries.value,
    settings,
  })

  /** seek / 重播统一入口：叠加层游标二分定位，列表按"从头到当前"重建 */
  function seekBarragesTo(time: number) {
    seekOverlayTo(time)
    buildListUpTo(time)
    currentTime.value = time
  }

  /** 播放推进：timeupdate 唯一入口，三条游标同步推进 */
  function onTimeUpdate(newTime: number) {
    currentTime.value = newTime
    advanceListTo(newTime)
    processOverlayDanmaku(newTime)
  }

  /** 弹幕晚于播放到达时，按当前进度补齐列表与叠加层 */
  async function ensureBarragesLoaded() {
    if (await loadBarrages(barrageUrl.value))
      seekBarragesTo(options.getMedia()?.currentTime ?? 0)
  }

  /** 弹幕数据源变化（换回放）：清空列表、叠加层与进度归零 */
  function resetBarrageSource() {
    resetBarrageList()
    seekBarragesTo(0)
  }

  /** 切换弹幕显隐：状态持久化，关闭时清空叠加层，重新打开不补灌历史弹幕 */
  function toggleDanmaku() {
    // 无弹幕数据源时开关无意义，直接忽略（含快捷键 D）
    if (!hasBarrage.value)
      return
    settings.enabled = !settings.enabled
    if (!settings.enabled)
      clearOverlay()
    saveSettings()
  }

  /** 设置弹层里改动的参数统一在这里落库 */
  function updateSettings(patch: Partial<DanmakuSettings>) {
    Object.assign(settings, patch)
    saveSettings()
  }

  return {
    currentTime,
    barrageUrl,
    hasBarrage,
    barrageEntries,
    barrageListItems,
    barrageLoaded,
    danmakuOverlayItems,
    setDanmakuNode,
    settings,
    seekBarragesTo,
    onTimeUpdate,
    ensureBarragesLoaded,
    resetBarrageSource,
    loadSettings,
    toggleDanmaku,
    updateSettings,
    startAnimation,
    stopAnimation,
  }
}
