/**
 * 房间「已关闭」判据。
 *
 * 关闭后的房间仍留在成员列表里：`im/server/jump` 会退到该 server 的直播频道
 * （实测 `channelName=直播`、`functionType=USER_LIVE`、`hasMsgBoard=0`），
 * 消息恒为空页 —— 与「房间还在、只是没人说话」在消息层面完全同形，
 * 所以只能靠 `im/team/room/info` 区分。两个信号：
 *
 * - `channelInfo.hasMsgBoard === 0`：该频道没有留言板，即房间关闭后的形态；
 * - 接口直接回错且文案含「关闭」：服务端直说。
 *
 * 不可用的字段（都已实测，别再拿来判）：
 * - `channelStatus`：正常房间同样非 0，曾据「非 0 = 已关闭」把全部房间误过滤；
 * - `userFunction`：房间级禁言同样是全 false，那是「不让发言」不是「房间没了」。
 */

/**
 * 房间是否已关闭：无留言板，或服务端明确回「已关闭」。
 * `hasMsgBoard` 传 null 表示字段缺失（协议变动）——不据此推断，宁可显示「暂无消息」。
 */
export function isRoomClosed(hasMsgBoard: boolean | null, errorMessage = ''): boolean {
  return hasMsgBoard === false || errorMessage.includes('关闭')
}
