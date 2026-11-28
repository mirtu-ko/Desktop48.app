# 房间消息链路

本文说明「房间」页的核心架构、跨进程边界、数据流与关键约束。与之并行的直播播放链路见 [live-playback-pipeline.md](./live-playback-pipeline.md)，房间发言与 QChat 协议细节见 [room-message-send.md](./room-message-send.md)。

## 1. 架构定位与分层

房间消息是口袋 App「房间」tab 的成员留言流，与浮窗播放器里的「直播间弹幕」是两套独立体系（QChat / HTTP vs NIM 聊天室）。所有口袋接口经主进程发出，token 不出主进程：

| 层级     | 模块                                                                 | 职责                                                    |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| 页面层   | `src/renderer/src/pages/Rooms.vue`                                   | 双栏展示、滚动钉底、未读分割线、草稿暂存、门禁与右键菜单 |
| 编排层   | `src/renderer/src/composables/use-pocket-rooms.ts`                   | 名单合并、排序、首屏水合、消息分页/轮询、QChat 订阅同步 |
| 协议归一 | `src/renderer/src/utils/pocket-room-message.ts`                      | HTTP 与 QChat 消息统一归一为 `PocketRoomMessageView`    |
| 预加载桥 | `src/preload/ipc-contract.d.ts` / `src/preload/index.ts`             | 强类型 IPC 契约（与 `register-pocket-ipc.ts` 三处同步） |
| 主进程   | `pocket-auth.ts` / `pocket-unread.ts` / `pocket-room-qchat.ts`       | 接口请求、未读检测唯一真相、QChat 长连接会话与消息推送  |

## 2. 核心接口（`pocketapi.48.cn`）

| 用途             | 端点                                            | 要点                                                              |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| 口袋关注 ID      | `user/api/v1/friendships/friends/id`            | 仅返回 ID 数组，昵称/头像由本地成员目录与 `officialInfo` 反查     |
| 解析房间频道     | `im/api/v1/im/server/jump`                      | `{ starId, targetType: 1 }` → `{ serverId, channelId }`           |
| 批量最新消息     | `im/api/v1/team/classic/last/message/get`       | 仅作未读探测触发与左列预览（`msgTime` 恒为 0，`unreadCount` 恒空） |
| 消息列表         | `im/api/v1/team/message/list/{homeowner,all}`   | `msgTime` 倒序 + `nextTime` 游标；`homeowner` 混入官方号 `121569667` |
| 精华消息         | `im/api/v1/team/essence/message/list`           | 频道级内容，与消息范围无关；进房时按频道缓存 5 分钟，不随轮询复查 |
| 频道详情与门禁   | `im/api/v1/im/team/room/info`                   | 房主反查、关闭判定（`hasMsgBoard`）、发言权限（`sendText`/`cdTime`）、门禁定性 |
| 暗号校验         | `im/api/v1/team/channel/question/answer/verify` | `{ answer, questionId }` → `success: true` 放行                   |
| Server 频道列表  | `im/api/seine/server/detail`                    | 拉取真实频道名与枚举小房间（主进程 60s 缓存）                     |

## 3. 列表加载、排序与临时房间

- **首灌与复用**：`load()` 先从 `localStorage`（`room-list-snapshot`）首帧水合列表，再并行拉取直播状态与关注名单，通过一次批量 IPC（`pocketGetRoomChannels`）命中主进程持久化频道缓存，最后回填预览并落快照。`KeepAlive` 切回（`onActivated`）时，若成员集合签名未变且在 60s 复用窗口内直接沿用列表；登出或换号时调用 `clearAccountCaches()` 清空账号相关缓存。
- **名单口径**：`口袋关注 ∪ 本地关注 − 本地屏蔽`（主进程与渲染层同源）。关注与屏蔽正交，屏蔽优先；屏蔽名单或本地关注变化时左列就地同步。官方号回退 `officialInfo` 展示，默认消息范围为 `all`。
- **七级排序**（`sortRooms`）：临时房间 → 本地置顶 → 已关闭沉底 → 直播中 → 有未读 → 最新未读时刻降序 → 中文昵称。**只在未读「浮上来」时重排**，读掉未读不立即抽走当前条目。
- **可用性与关闭判定**：
  - 列表过滤只认 `im/server/jump` 是否返回有效频道（不看语义不明的 `channelStatus`）。
  - 房间关闭后 `jump` 可能退到直播频道（`hasMsgBoard=0`），此时仍留在左列但标为已关闭并沉底；主进程将关闭前的旧留言频道随快照广播，供「按日期查看」读取历史。
- **临时房间与深链**：`/rooms?member=<userId>` 命中已关注成员时直接走 `enterRoom(userId, 'query')` 并清掉 query；未关注成员建临时条目（仅存内存、不参与未读），保留 query 维系其生命周期。

## 4. 消息流、轮询与归一化

- **双链路收消息**：
  - **实时推送（主路径）**：进房即自动订阅 QChat（见 [room-message-send.md](./room-message-send.md)），推送 `24/11`、发送 ACK 与 HTTP 轮询按 `msgIdClient` 三源去重。
  - **HTTP 轮询（兜底）**：`fetchRoomPage` 统一首屏 `replace`、上翻 `prepend`、增量 `append`。QChat 健康时自动降频到 **30s**，断线切回 **5s**；`KeepAlive` 切去其他页面时暂停定时器并拦截后台推送，切回 `onActivated` 时通过 `pollRoomMessages(true)` 绕过 30s 节流立即补拉。
- **分页与游标约束**：
  - `append` 轮询与 QChat 推送**绝不写 `historyCursor`**，也**不判到头**。
  - 上翻连续 2 次无进展（无新增且游标未前移）才置 `historyExhausted`；游标归 0 时改用最早持有消息的 `msgTime` 兜底探测。
  - 切换 `只看房主 / 全部消息` 走 `reloadMessagesForScope()`，只复位消息流，保留当前频道与精华缓存。
- **左列预览所有权**：日常更新由主进程 `pocketUnreadBatch.previews` 镜像广播（替代渲染层自有预览轮询）；选中且在大房间视图的未关闭房间归消息轮询即时维护，批量预览不回写。
- **归一化要点（`pocket-room-message.ts`）**：
  - `DELETE` 返回 `null` 过滤；未识别类型降级展示不丢弃；`TEXT` 中不含 `text`/`messageType` 的非空 JSON 字面量原样保留文本（`{}` 返回空串）。
  - `replyInfo.text` 是本条回复正文，`replyInfo.replyText` 是被引用内容。
  - 翻牌（`FLIPCARD*`）兼容 `flipCard*` / `filpCard*` 拼写，独立渲染为问答卡（不复用引用块）。
  - 表情占位符（`[爱心]`）仅在用户原文处映射为 emoji，不对 `[图片消息]` / `[礼物]` 等业务前缀替换。

## 5. 未读检测与已读水位（主进程唯一真相）

`main/pocket48/pocket-unread.ts` 持有全部未读状态并持久化至 `userData/pocket48-unread.json`（原子写），变化经 `pocketUnreadBatch` 广播并同步 Dock / 托盘角标。

- **两步计数（60s 一轮）**：先用批量预览接口比对 `seenKeys` 判「哪些频道有新消息」，再对触发的频道拉一页 `homeowner` 消息（剔除官方号 `121569667`），数出比 `readMarks` 水位更新的条数（单频道封顶 `ROOM_MESSAGE_LIMIT`）。大房间每轮探测，小房间每 5 轮探测一次（首见锚定与 `alignPending` 不降频）；每轮最多探测 9 个频道，按上次探测时刻轮转。
- **自愈机制**：
  - 未归属频道通过 `room/info` 反查房主或门禁（`healChannelOwners`），并记录已关闭的历史频道。
  - 有效大房间按 60 分钟 TTL 定期复核归属（每轮最多 2 个）；有未读且超 30 分钟未探测的频道强制补探并校对归属。
- **水位与竞态护栏**：
  - 水位只在**首见锚定**与 **`markRead`** 推进，检测轮绝不推进。
  - `markRead(userId, target)` 返回清零前的旧水位（供渲染层画分割线），先递增 `markEpoch` 使在途 `probeChannels` 回包作废，再按频道清零、广播，最后拉一页列表对齐水位（失败入 `alignPending` 下轮补齐）。
- **页面可见性与桌面端 IM 体验**：
  - 页面可见性定义为 `pageVisible = pageActive && docVisibility === 'visible'`。窗口隐藏或 `KeepAlive` 切去其他页面时一律不标已读；切回可见且有未读时，截旧水位画「以下是 N 条新消息」分割线再清零。
  - `markRoomReadCapturing` 与 `settleBigRoomEnter` 入口均复核 `selectedUserId` 与 `viewMode`，防止切房/切页签加载中误清未在看频道。
  - 分割线与底部未读胶囊共用 `unreadShownText`（非 `beyond` 报精确条数，`beyond` 补页触顶后统一走 `50+` 封顶）；水位沉出首屏时由 `fillUnreadWindow` 最多补拉 4 页。

## 6. 小房间与门禁

- **发现与缓存**：主进程通过 `seine/server/detail` 枚举同 server 下非大房间频道并试探 `room/info`，被 `question`（暗号）或 `chicken-leg`（赠送鸡腿）门禁拦下即记入 `smallChannels`（按 server 30 分钟节流，频道失效时 `invalidateSmallChannel` 立即作废并强制重枚举）。同一 server 挂多位关注成员时不猜归属。
- **门禁定性（`classifyChannelGate`）**：按「暗号信封 → 文案关键字（鸡腿）→ 业务码（2002/2003 贡献/守护）→ `unknown`」顺序判定；门禁拒绝在 `probeChannels` 中不计 `failCount`。
- **界面与解锁**：页签栏始终渲染（`roomTabs.length > 0`）。暗号门禁提供输入框并通过 `question/answer/verify` 校验（解锁态存渲染层内存）；鸡腿与贡献/守护等不可作答门禁只展示服务端原文与说明，不给输入框。

## 7. 页面级交互约束（`Rooms.vue`）

- **按频道暂存草稿**：以 `${userId}:${viewMode}` 为键暂存输入草稿，切房或切大小房间不串房，登出清空；发送前截下 `sendKey` 防止发送在途切房误清目标房间草稿。
- **滚动与长文**：`atBottom` 为钉底开关，仅用户主动上滚时退钉，图片/视频加载撑高后自动补贴底；正文超 10 行用 `max-height` 折叠以保持 `scrollHeight` 测量稳定。
- **按日期查看**：`RoomDateDialog` 走独立只读轨道，不干扰主消息流、已读水位与轮询。
