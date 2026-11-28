/**
 * 开放公演卡片的共用判定与点击选路：公演页（Shows.vue）与直播页空态的公演预告（Lives.vue）共用。
 *
 * - 纯函数（isShowLive / showLockedHint / isTodayShow）不依赖组件上下文，可在 computed / 模板里直接调用；
 * - useShowActions 负责「点了之后做什么」：进行中开直播窗，其余弹提示说明原因，历史公演开回放窗。
 */
import type { OpenLive } from '@renderer/services/api-types'
import useFloatPlayersStore from '@renderer/stores/float-players'
import { resolveBilibiliRoomIdAsync } from '@renderer/utils/bilibili-room'
import Constants from '@renderer/utils/constants'
import { debugLog } from '@renderer/utils/debug'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'

/** 直播页当前在播数少于该阈值时，若存在进行中公演则一并展示 */
export const LIVE_SHOWS_THRESHOLD = 10

/** 直播页列表态最多展示的进行中公演场数 */
export const MAX_ONGOING_SHOWS = 4

/** 是否进行中：公演卡片「可点击」的唯一真值来源 */
export function isShowLive(show: Pick<OpenLive, 'status'>): boolean {
  return show.status === Constants.ShowStatus.Live
}

/** 不可点击卡片的原因文案（可点击时为空）：封面角上已有时间，这里不重复 */
export function showLockedHint(show: Pick<OpenLive, 'status' | 'stime'>): string {
  if (isShowLive(show))
    return ''
  if (show.status === Constants.ShowStatus.Ended)
    return '已结束 · 暂无回放'
  // Scheduled：区分「时间没到」与「已过点但还没推流」
  const started = Number.parseInt(show.stime) <= Date.now()
  return started ? '尚未开始直播 · 请稍候' : '计划中 · 开播后观看'
}

/** 是否当天开演（本地时区自然日）：公演页「即将开始」分区与直播页「今晚公演」共用 */
export function isTodayShow(show: Pick<OpenLive, 'stime'>): boolean {
  const date = new Date(Number.parseInt(show.stime))
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
}

/** 筛选进行中的公演、按开演时间升序并归一化封面地址（默认不截断，保留总数供标题计数） */
export function pickOngoingShows(shows: readonly OpenLive[], limit?: number): OpenLive[] {
  const list = shows
    .filter(show => isShowLive(show))
    .sort((a, b) => Number.parseInt(a.stime) - Number.parseInt(b.stime))
    .map(show => ({
      ...show,
      coverPath: show.coverPath ? Tools.sourceUrl(show.coverPath) : show.coverPath,
    }))
  return limit !== undefined ? list.slice(0, limit) : list
}

/** 直播列表态是否应伴随展示进行中公演：在播数少于阈值且未开启「只看关注」 */
export function shouldShowOngoingShowsInList(liveCount: number, onlyFollowed: boolean): boolean {
  return liveCount > 0 && liveCount < LIVE_SHOWS_THRESHOLD && !onlyFollowed
}

export function useShowActions() {
  const { openLive, openPlayback } = useFloatPlayersStore()

  /** 进行中的公演：以独立播放窗直接打开直播；非进行中忽略（入口应先经 onShowClick 判定） */
  async function openShowLive(show: OpenLive): Promise<void> {
    if (!isShowLive(show)) {
      debugLog('show', `公演选路: ${show.liveId} 状态=${show.status}（非进行中），忽略本次点击`)
      return
    }
    debugLog('show', `公演选路: ${show.liveId} 进行中 → 进入直播链（LivePlayer, source=open）`, show)
    // 弹幕房间三级解析：groupId → 标题文本 → 在播官方房间标题兜底；全部落空则无弹幕入口
    const bilibiliRoomId = await resolveBilibiliRoomIdAsync({
      groupId: show.teamList?.[0]?.groupId,
      texts: [show.title, show.subTitle],
    })
    openLive({
      liveId: show.liveId,
      nickname: show.teamList?.[0]?.teamName || '',
      title: show.subTitle || show.title,
      startTime: Number.parseInt(show.stime),
      source: 'open',
      // 公演没有主播头像，用封面作窗口头像（与录播窗口一致）
      avatar: show.coverPath,
      liveType: 1,
      liveMode: 0,
      bilibiliRoomId,
    })
  }

  /** 排期卡片点击：进行中直接开播；其余弹提示说明原因，避免点了没反应 */
  async function onShowClick(show: OpenLive): Promise<void> {
    if (isShowLive(show)) {
      await openShowLive(show)
      return
    }
    debugLog('show', `公演选路: ${show.liveId} 状态=${show.status}（非进行中），提示用户原因`)
    ElMessage({
      type: 'info',
      message: showLockedHint(show),
      grouping: true,
    })
  }

  /** 历史公演（已结束）：以独立回放窗打开 VOD 流，停留当前页继续浏览 */
  function openShowPlayback(show: OpenLive): void {
    debugLog('show', `公演选路: ${show.liveId} → 进入录播链（PlaybackPlayer, source=open）`, show)
    openPlayback({
      liveId: show.liveId,
      nickname: '',
      title: show.subTitle || show.title,
      startTime: Number.parseInt(show.stime),
      source: 'open',
      // 公演没有主播头像，用封面作窗口头像（与录播窗口一致）
      avatar: show.coverPath,
      liveType: 1,
      liveMode: 0,
    })
  }

  return { openShowLive, onShowClick, openShowPlayback }
}

export default useShowActions
