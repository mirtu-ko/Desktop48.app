import { ROOM_MESSAGE_LIMIT } from '@common/pocket-rooms'

/**
 * 房间未读的展示口径与「贴底自愈」判定（纯函数，可脱离 Electron 单测）。
 *
 * 未读有两个数，不能混用：
 * - 角标数：主进程检测轮数出来的条数，进房时被快照下来（60s 一轮，异步）；
 * - 可见区域数：消息列表里比已读水位新的条数（进房拉到的首屏，即时）。
 * 进房瞬间又到的新消息只在后者里，两者会差 1～几条；同一屏里必须只出现一个数，
 * 否则就是「分割线 4 条、底部胶囊 3 条」。
 */

/** 未读数字文案：检测侧按一页封顶，触顶即「至少这么多」，收敛为 50+ */
export function unreadBadgeText(count: number): string {
  return count >= ROOM_MESSAGE_LIMIT ? `${ROOM_MESSAGE_LIMIT}+` : String(count)
}

/**
 * 分割线与底部胶囊共用的条数：以可见区域为准。
 * 水位落在未加载区域（beyond）时可见区域只是「当前窗口」、不代表全部，
 * 退回进房时的角标快照。
 */
export function unreadShownCount(input: { region: number, snapshot: number, beyond: boolean }): number {
  return input.beyond ? input.snapshot : input.region
}

/**
 * 贴底自愈：镜像里当前房间、当前频道又冒出未读时，是否该再标一次已读。
 *
 * 贴底标记（进房 / 回底 / 收到新消息）与主进程 60s 检测轮有竞态：标记时主进程还没
 * 探测到这条消息，count 为 0，`markRead` 只清零、不推进已读水位；随后检测轮把它
 * 数出来，角标就挂在用户已经看过的消息上，直到下一次标记。这里在角标回来时再标一次
 * （此时 count>0，主进程会清零并把水位推到最新）。
 *
 * 只在「用户确实正看着最新一条」时成立：贴底、窗口可见、有消息、且不在进房 / 切
 * 频道收尾（收尾期间要截旧水位画分割线，不能先清）。
 */
export function shouldAutoMarkSeen(input: {
  unread: number
  atBottom: boolean
  pageVisible: boolean
  hasMessages: boolean
  entryBusy: boolean
}): boolean {
  return input.unread > 0
    && input.atBottom
    && input.pageVisible
    && input.hasMessages
    && !input.entryBusy
}
