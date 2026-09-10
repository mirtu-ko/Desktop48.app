/**
 * ⚠️ 全局单例 store（原 composables/use-float-players.ts）
 *
 * 画中画窗口列表定义在模块作用域，**不随任何组件卸载而销毁**：
 * 直播 / 回放 / 公演三个列表页调用 useFloatPlayersStore() 打开的是同一组迷你窗。
 */
import { ref } from 'vue'

export interface FloatPlayerPayload {
  liveId: string
  /** 主播名称：有值时迷你窗标题栏展示为 nickname + title */
  nickname?: string
  /** 播放器头部标题 */
  title: string
  startTime: number
  /** 1=视频直播 2=电台 */
  liveType?: number
  /** 0=直播 1=录屏 */
  liveMode?: number
  /** 数据源：user=用户直播(getLiveOne)，open=开放公演(getOpenLiveOne) */
  source?: string
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatar?: string
}

export interface FloatPlayerItem {
  id: string
  /** live=直播，playback=回放 */
  kind: 'live' | 'playback'
  payload: FloatPlayerPayload
  /** 创建序号：用于迷你窗级联定位，避免多窗完全重叠 */
  order: number
}

// 模块级单例：跨页面（直播/回放/公演 keep-alive 复用）共享同一份播放窗口列表
const players = ref<FloatPlayerItem[]>([])
let seed = 0

function createId() {
  return `fp-${Date.now().toString(36)}-${(seed++).toString(36)}`
}

/**
 * 画中画迷你窗全局管理：点击卡片不再走顶部 tab，而是打开一个可拖拽的
 * 悬浮迷你播放窗，边看边继续浏览列表。同一直播/回放重复点击时置顶复用。
 */
export function useFloatPlayersStore() {
  /** 打开直播迷你窗；同一直播已存在时直接置顶复用 */
  function openLive(payload: FloatPlayerPayload) {
    openPlayer('live', payload)
  }

  /** 打开回放迷你窗；同一回放已存在时直接置顶复用 */
  function openPlayback(payload: FloatPlayerPayload) {
    openPlayer('playback', payload)
  }

  function openPlayer(kind: 'live' | 'playback', payload: FloatPlayerPayload) {
    const existing = players.value.find(
      p => p.kind === kind && p.payload.liveId === payload.liveId,
    )
    if (existing) {
      focusPlayer(existing.id)
      return
    }
    players.value.push({ id: createId(), kind, payload, order: seed++ })
  }

  /** 把指定窗口移到数组末尾（z-index 取数组下标，达到置顶效果） */
  function focusPlayer(id: string) {
    const idx = players.value.findIndex(p => p.id === id)
    if (idx < 0)
      return
    const [item] = players.value.splice(idx, 1)
    players.value.push(item)
  }

  function closePlayer(id: string) {
    const idx = players.value.findIndex(p => p.id === id)
    if (idx >= 0)
      players.value.splice(idx, 1)
  }

  return { players, openLive, openPlayback, focusPlayer, closePlayer }
}

export default useFloatPlayersStore
