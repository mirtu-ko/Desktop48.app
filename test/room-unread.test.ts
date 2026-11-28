import { describe, expect, it } from 'vitest'
import { shouldAutoMarkSeen, unreadBadgeText, unreadShownCount, unreadShownText } from '../src/renderer/src/utils/room-unread'

/** 未读展示口径（纯函数）：数字文案、分割线/胶囊共用条数、贴底自愈判定 */

describe('unreadBadgeText', () => {
  it('按一页封顶收敛为 50+', () => {
    expect(unreadBadgeText(0)).toBe('0')
    expect(unreadBadgeText(3)).toBe('3')
    expect(unreadBadgeText(49)).toBe('49')
    expect(unreadBadgeText(50)).toBe('50+')
    expect(unreadBadgeText(999)).toBe('50+')
  })
})

describe('unreadShownCount', () => {
  it('正常情况用可见区域条数：进房瞬间又到一条时比角标快照多', () => {
    // 分割线 4 条、胶囊 3 条的那个场景：角标快照 3，进房后可见区域 4
    expect(unreadShownCount({ region: 4, snapshot: 3, beyond: false })).toBe(4)
  })

  it('水位在未加载区域（beyond）时可见区域不代表全部，退回角标快照', () => {
    expect(unreadShownCount({ region: 50, snapshot: 3, beyond: true })).toBe(3)
  })
})

describe('unreadShownText', () => {
  it('非 beyond 且补页超过 50 条时直接报实数，分割线与底部胶囊保持一致', () => {
    expect(unreadShownText({ region: 65, snapshot: 50, beyond: false })).toBe('65')
  })

  it('beyond 时退回快照并沿用 50+ 封顶口径', () => {
    expect(unreadShownText({ region: 200, snapshot: 50, beyond: true })).toBe('50+')
    expect(unreadShownText({ region: 200, snapshot: 12, beyond: true })).toBe('12')
  })
})

describe('shouldAutoMarkSeen', () => {
  const base = { unread: 1, atBottom: true, pageVisible: true, hasMessages: true, entryBusy: false }

  it('贴底、可见、有消息、不在收尾时补标', () => {
    expect(shouldAutoMarkSeen(base)).toBe(true)
  })

  it('未读为 0 时不补标（没有角标可清）', () => {
    expect(shouldAutoMarkSeen({ ...base, unread: 0 })).toBe(false)
  })

  it('上翻浏览中不补标（用户还没看到最新一条）', () => {
    expect(shouldAutoMarkSeen({ ...base, atBottom: false })).toBe(false)
  })

  it('窗口隐藏时不补标（看不见，静默清零等于吞未读）', () => {
    expect(shouldAutoMarkSeen({ ...base, pageVisible: false })).toBe(false)
  })

  it('首屏没有消息时不补标（无处可读）', () => {
    expect(shouldAutoMarkSeen({ ...base, hasMessages: false })).toBe(false)
  })

  it('进房 / 切频道收尾在途时不补标（分割线还要截旧水位）', () => {
    expect(shouldAutoMarkSeen({ ...base, entryBusy: true })).toBe(false)
  })
})
