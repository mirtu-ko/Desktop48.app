import { onScopeDispose, ref, watch } from 'vue'

/**
 * 「指示最短可见时长」：把一闪而过的 loading 拉长到人眼可辨。
 *
 * 本项目的列表接口数据量都小、回包常在几十毫秒内，指示亮不到两帧，用户根本看不出
 * 「刷过」——人眼对状态变化的可辨阈值约 250ms。这里只延长**指示**，不延长数据：
 * loading 落下时若未满 minMs，就把指示多留一会儿；这段时间内又升起则取消收起，
 * 指示保持常亮，不会出现「灭一下再亮」的抖动。
 *
 * 传入的是 getter（`() => props.loading`）而不是值，这样内部 watch 能直接跟随来源。
 * 每次调用返回独立状态，所以放 composables 而不是 stores。
 *
 * @returns 供 UI 消费的可见性，避免用原始 loading 直接驱动指示
 */
export default function useMinVisibleLoading(isLoading: () => boolean, minMs = 600) {
  const visible = ref(false)
  /** 本轮指示点亮的时刻；只在 false → true 的上升沿重置 */
  let shownAt = 0
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  watch(isLoading, (loading) => {
    if (loading) {
      cancelHide()
      shownAt = Date.now()
      visible.value = true
      return
    }
    // shownAt 初值为 0 = 「从未点亮」，此时 remain 必然为负，不会误亮
    const remain = minMs - (Date.now() - shownAt)
    if (remain <= 0) {
      visible.value = false
      return
    }
    cancelHide()
    hideTimer = setTimeout(() => {
      hideTimer = null
      visible.value = false
    }, remain)
  }, { immediate: true })

  // 组件卸载 / 页面被销毁时清掉挂起的收起，避免带着定时器一起走
  onScopeDispose(cancelHide)

  return visible
}
