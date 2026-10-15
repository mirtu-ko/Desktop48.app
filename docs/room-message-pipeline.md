# 房间消息链路

本文说明「房间」页的完整调用链路：从 Dock 入口到房间列表与消息流渲染，覆盖模块划分、跨进程边界、接口取舍与数据形态。

数据结构与协议解析参考 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)。与之对应的直播播放链路见《播放链路》（live-playback-pipeline.md），两者互不依赖。

## 0. 设计前提

### 0.1 房间消息不是直播间弹幕

本项目并行存在两套独立的消息体系，接口、协议、渲染位置均不同，改动前需先区分：

| 维度       | 直播间弹幕                 | 房间消息（本文）                               |
| ---------- | -------------------------- | ---------------------------------------------- |
| 产品形态   | 浮窗播放器里的实时互动     | 口袋 App「房间」tab 的成员留言流               |
| 传输方式   | 自研网易云信 TCP 长连接    | HTTP 拉取 + 渲染层轮询                         |
| 入口       | 直播/回放独立播放窗        | Dock「房间」→ `pages/Rooms.vue`                |
| 数据源     | NIM 聊天室（`chatroomId`） | team server + channel（`im/server/jump` 解析） |
| 主进程模块 | `pocket-danmaku.ts`        | `pocket-auth.ts` + `pocket-unread.ts`          |

参考实现的实时房间消息走 QChat 长连接（另一套 NIM 协议），本版本以 5s 轮询替代：房间留言流的时效要求远低于弹幕，该粒度可满足查看需求。

### 0.2 接口无文档，结构自参考实现推导

口袋48 im 域接口无官方文档，请求/回包结构均从参考实现交叉验证得出。字段名宽容匹配代码（`firstStr` 多候选键、`??` 兜底）即由此而来，不应视为冗余代码删除。

### 0.3 token 存于主进程，链路跨进程

所有口袋接口经 `main/pocket48/pocket-auth.ts` 的 `postPocket` 发出：token 仅存于主进程，请求使用 Electron `net.request`（规避渲染层 fetch 的 CORS 与系统代理问题）。每次数据交互均为一次 IPC：

| 角色     | 目录                                  | 职责                                     |
| -------- | ------------------------------------- | ---------------------------------------- |
| 渲染进程 | `pages/Rooms.vue`                     | 页面展示与交互（滚底、翻历史、媒体播放） |
| 编排层   | `composables/use-pocket-rooms.ts`     | 名单合并、频道遍历、消息拉取/轮询编排    |
| 预加载桥 | `src/preload/index.ts`                | 暴露 `window.mainAPI.pocketGetRoom*`     |
| 主进程   | `pocket-auth.ts` / `pocket-unread.ts` | 接口请求、未读检测（唯一真相）           |

IPC 契约按项目约定三处同步：`preload/ipc-contract.d.ts` → `preload/index.ts`（`satisfies mainAPI`）→ `main/ipc/register-pocket-ipc.ts`（`handleTraced` 注册）。漏一处 `npm run typecheck` 直接失败。

## 1. 接口清单

全部位于 `pocketapi.48.cn`，均需登录 token：

| 用途                     | 端点                                            | 关键入参                                   | 回包要点                                                            |
| ------------------------ | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| 口袋关注 ID 列表         | `user/api/v1/friendships/friends/id`            | 无（token 即账号）                         | 纯 ID 数组，不含昵称/头像（需本地成员目录反查）                     |
| 成员 userId → 房间频道   | `im/api/v1/im/server/jump`                      | `{ starId, targetType: 1 }`                | `{ serverId, channelId }`；解析不出 = 没有房间                      |
| 批量取各频道最后一条消息 | `im/api/v1/team/classic/last/message/get`       | `{ serverIdList: number[] }`               | `lastMsgList`：每频道一条，`msgTime` 实测恒为 0                     |
| 房间消息（只看成员）     | `im/api/v1/team/message/list/homeowner`         | `{ channelId, serverId, nextTime, limit }` | `message` + `nextTime` 游标；混入官方账号 121569667                 |
| 房间消息（全部用户）     | `im/api/v1/team/message/list/all`               | 同上                                       | 同上                                                                |
| 小房间暗号题面           | `im/api/v1/im/team/room/info`                   | `{ channelId }`                            | 暗号频道回 `status 2001`，`message` 内嵌 `{ questionId, question }` |
| 暗号作答校验             | `im/api/v1/team/channel/question/answer/verify` | `{ answer, questionId }`                   | `success: true` 即通过；否则 `message` 为「回答错误 / 问题不存在」  |
| 频道名（seine 频道详情） | `im/api/seine/server/detail`                    | `{ serverId }`                             | `content.channelInfoList[].channelName`                             |

## 2. 调用链路总览

### 2.1 首灌（进页面 / 手动刷新）

```
[Rooms.vue] onMounted → load()（keep-alive 页面只挂载一次；重新进入走 onActivated → refreshRoomStatus(false)）
   │  未登录：整页登录引导，不发任何口袋接口请求
   ▼
[use-pocket-rooms.ts] load()
   ├─ refreshPocketAuthState()   等登录态落库（同步返回旧值 + 异步刷新，冷启动首帧会误判未登录）
   ├─ loadFollowedIds()          口袋关注 ID ∪ 本地关注 ID（并集，只增不删）；失败则降级为本地名单
   ├─ fetchLiveMap(true)         共享 live-status store（120s 缓存，force 强制刷新）
   ├─ 成员目录反查               头像/昵称/队伍（接口不返回；查不到降级「口袋用户 N」）
   ├─ resolveRooms(entries)      有界并发 5 遍历 im/server/jump
   │     ├─ 解析失败/空频道 → 过滤（无房间，含已关闭），计入 hiddenRoomCount
   │     ├─ 成功 → 写入 channelCache（userId → 频道）
   │     └─ 全部解析异常（接口故障）→ 整页 loadError + 重试按钮，不展示空列表
   └─ fetchLastMessageMap(...)   一次批量请求取全部频道最新一条 → 左列预览
   ▼
rooms.value（在直播的排前，其余按昵称 localeCompare('zh')）
```

### 2.2 选中房间与轮询

```
[Rooms.vue] @click="selectRoom(room.userId)"
   ▼
[use-pocket-rooms.ts] selectRoom(userId)
   ├─ clearChat()                选中序号 ++（在途回包作废，防消息串房）+ 复位游标/去重键
   ├─ channelCache 命中 → 直接用；未命中（关注后新增）才懒解析 jump
   ├─ fetchRoomPage(channel, 0, 'replace')
   │     pocketGetRoomMessages(channelId, serverId, nextTime=0, scope)
   │     → normalizePocketRoomMessage 逐条归一（DELETE 类返回 null 过滤）
   │     → mergeMessages(replace)：接口 msgTime 倒序 → 翻转为时间升序
   │     → historyCursor = nextTime（0 = 没有更多）
   └─ chatStatus='ready' → resumeMessagePoll()

轮询（useIntervalFn，5s，随页面激活态暂停/恢复）：
    pollRoomMessages() → fetchRoomPage(activeChannel, 0, 'append')
    └─ 只追加没见过的新消息（messageKeys 去重），并同步左列预览到最新一条

翻历史（贴顶自动 / 按钮）：
    loadMoreHistory() → fetchRoomPage(activeChannel, historyCursor, 'prepend')
```

## 3. 各阶段数据形态

**① 房间条目 `PocketRoom`**：`userId`、`nickname`（成员目录反查，查不到降级「口袋用户 N」）、`avatar`、`teamName`、`teamColor`、`serverId` / `channelId`、`preview`（左列预览，空串 = 暂无消息）、`previewTime`（预览对应消息时刻，防旧快照覆盖更新的本地预览）、`live`（匹配到的在播直播；留言流与直播与否无关）。

**② 房间频道 `PocketRoomChannel`**：`serverId` / `channelId` 来自 `im/server/jump` 回包 content；两者为空串表示该成员没有房间（未开通，或已关闭/被回收，见第 4 节）。`targetType: 1` 为固定值。

**③ 消息归一化**：原始 `PocketRoomMessage`（CustomMessageV2：`msgIdServer`、`msgIdClient` 去重键首选、`msgType` 决定正文语义、`msgTime`、`bodys` 多为 JSON 字符串、`extInfo` 内嵌 `user` 资料）经 `utils/pocket-room-message.ts` 输出 `PocketRoomMessageView`，消息流、引用块、相册、语音条、分享卡共用：`id`（`msgIdClient || msgIdServer || msgTime`，轮询/翻历史去重键）、`kind`、`text`、发送者资料（`userId` / `nick` / `avatar` / `level` / `isMember`）、`msgTime`、`quote`（仅回复类，含被引用昵称/文本/是否礼物）、`imageUrl` + 原始尺寸、`audioUrl`、`videoUrl` + `videoPoster`、直播分享字段（`liveId` / `liveType` / `liveMode` / `liveStartTime` / `liveCover` / `liveIsPlayback`）。

**④ 批量最新消息 `PocketRoomLastMessage`**：`channelId`、`serverId`、`starName`（**最后发言人**而非房主）、`msgContent`、`msgKey`（消息身份键：msgidClient 优先，最后退 `msgTime:msgContent`）、`msgTime`（⚠️ 实测恒为 0，不可作时间轴，见第 7 节）、`unreadCount`。

**⑤ 未读快照 `PocketUnreadBatch`**：`{ rooms: { userId: { count, latestTime } }, total }`。主进程唯一真相的全量镜像，渲染层只读；变化经 `pocketUnreadBatch` 广播到所有窗口。

关注名单（`loadFollowedIds()` → `number[]`）取口袋账号关注与本地关注（member-flags store）的**并集，只增不删**：本地关注是用户主观行为，口袋接口失败或未登录时不得清除；反向同步（本地新增 → 双写口袋）见成员页「关注」实现。

## 4. 房间可用性判定：只认 jump 解析

列表过滤的唯一依据是 `im/server/jump` 能否解析出频道：接口抛错 → 按无房间过滤并计入 `hiddenRoomCount`（左列显示「已隐藏 N 个」）；接口成功但 `serverId` / `channelId` 为空 → 同样过滤。**全部成员解析异常**时整页报错——此时为接口故障而非确实无房间，展示错误与重试入口而非静默空列表。

⚠️ **不应将 `im/team/room/info` 的 `channelStatus` 作为关闭判据**。该字段语义不明：实测正常房间同样返回非 0（曾据「非 0 = 已关闭」过滤，导致全部房间被误过滤）；真正关闭的房间在 jump 阶段即解析不出频道，已由上述路径覆盖。`room/info` 现用于两处：未读检测的频道归属反查（`getRoomChannelOwner`）与小房间的暗号题面拉取（`getRoomQuestion`，见第 8 节）。

## 5. 消息拉取：倒序、游标、轮询

`fetchRoomPage(channel, nextTime, mode)` 统一三种数据流，接口始终按 `msgTime` 倒序（最新在前）返回：

| mode      | 触发场景     | nextTime | 合并方式                     |
| --------- | ------------ | -------- | ---------------------------- |
| `replace` | 选中房间首屏 | 0        | 翻转为时间升序，整体替换     |
| `prepend` | 翻更早历史   | 游标     | 排序后插到头部               |
| `append`  | 轮询新消息   | 0        | 去重后排序追加，同步左列预览 |

- 去重键 `messageKeys`：`msgIdClient || msgIdServer || msgTime`，轮询与翻历史共用；
- `historyExhausted` **仅认 `nextTime === 0`**——本页条数不足 limit 不表示已到末页（服务端分页策略不透明，曾按条数判断导致更早历史无法拉取）；
- 轮询增量的预览同步按消息时刻比较（`previewTime`），防止批量预览的旧快照覆盖更新的本地预览；
- 轮询间隔 5s，仅选中房间就绪后启动，且**需以 `onActivated` / `onDeactivated` 控制定时器**：主窗口页面走 keep-alive，切页不销毁，仅挂 `onMounted` 时切页后仍在后台运行（房间页在主窗口内，不受失焦节流影响）；
- 消息范围 `homeowner`（只看成员）/ `all`（全部用户）两档，切换即重拉当前房间。`homeowner` 会混入口袋官方系统账号 `121569667`，渲染层按 `userId` 过滤。

## 6. 消息归一化

`utils/pocket-room-message.ts` 是整个房间链路的协议层，与弹幕归一化（`pocket-chat-message.ts`）是两份独立实现，不共用代码。

### 6.1 msgType 分发

| msgType                                                    | kind        | 正文                                  |
| ---------------------------------------------------------- | ----------- | ------------------------------------- |
| `TEXT` / 未知                                              | text        | bodys 纯文本整体 / JSON 取 `text`     |
| `IMAGE` / `EXPRESSIMAGE`                                   | image       | `[图片消息]`（解析直链 + 尺寸）       |
| `AUDIO`                                                    | audio       | `[语音消息]`（解析直链，语音条播放）  |
| `VIDEO`                                                    | video       | `[视频消息]`                          |
| `REPLY` / `GIFTREPLY` / `AUDIO_REPLY` / `AUDIO_GIFT_REPLY` | reply       | 回复自己的话；被引用内容进 quote      |
| `FLIPCARD` / `FLIPCARD_AUDIO` / `FLIPCARD_VIDEO`           | flip        | 答案文本 / `[翻牌回复]`               |
| `LIVEPUSH` / `OPEN_LIVE` / `SHARE_LIVE` 等                 | live        | `[直播分享] 标题`（解析 liveId 封面） |
| `PRESENT_NORMAL` / `GIFT_TEXT` 等                          | gift        | `[礼物] 名 xN`                        |
| `VOTE` / `DISABLE_SPEAK` / `CLOSE_ROOM_CHAT`               | vote/system | 占位文案                              |
| `DELETE`                                                   | —           | **返回 null**，不展示                 |

未识别类型不丢弃：`extMsgType` 动态消息（POST_INFO 等）使用兜底文本，为空时显示 `[新消息]`。协议侧语音类型名是 `AUDIO` 不是 `VOICE`。左列预览（`normalizePocketRoomPreview`）复用同一套分发，两侧文案一致；左列单行无法容纳引用块，回复类预览以「回复 昵称」前缀保留上下文，无正文时退回被引用内容。

发送者资料主路径取 `extInfo.user`（userId/nickName/avatar/level/roleId），顶层字段兜底；`roleId > 1` 判定成员（昵称着色 + 「房主」标签）。userId 需宽松数字强转——接口对纯数字 ID 返回 number 与 string 不定。

### 6.2 引用块：replyInfo 的字段语义

⚠️ 易错字段（曾因语义颠倒导致引用内容丢失、回复正文错显）：

- `replyInfo.text` = **本条回复自己的正文**；
- `replyInfo.replyText` = **被引用消息的文本**；
- `replyInfo.giftInfo` = 被引用的是礼物消息时，摘要走 `[礼物] 名 xN` 并标金。

引用块为**只读展示**，不提供点击跳转：被引用消息往往不在当前列表（更早历史未拉到 / 被范围过滤 / 原消息已删）。`replyMessageId` 字段仍在协议中，本版本不解析。

## 7. 未读检测（主进程唯一真相）

`main/pocket48/pocket-unread.ts`，与任务列表同一套「主进程真相 + 各窗镜像」模式：页面没开、窗口最小化时未读照常积累（定时器在主进程，不受 Chromium 失焦节流影响）。

```
tick()（60s，重入护栏）
  ├─ 未登录 → 清空未读与回执键（账号相关状态），广播
  ├─ getFollowedIds() → ensureChannels()
  │     └─ 缺失/占位过期的成员：并发 4 解析 jump；空频道按 30min TTL 重试
  ├─ getRoomLastMessages(serverIds 去重)   一次请求覆盖全部频道
  ├─ 逐条比对「消息身份键」（msgKey，⚠️ msgTime 恒为 0，只能靠它）
  │     ├─ 首见该频道 → 锚定当前最新消息，历史不算未读
  │     ├─ msgKey ≠ 已计入键 → 未读 +1（每频道只回最新一条，粗算）
  │     └─ 相同 → 跳过
  ├─ healChannelOwners()  未归属频道自愈（见下）
  └─ 落盘 + broadcastIpc('pocketUnreadBatch') + app.setBadgeCount
```

实现约束：

- **回执键按 `channelId` 存**，不按 userId——同一成员存在大房间与小房间两个频道，按 userId 存储会相互覆盖；
- **markRead 只删回执键，不接受渲染层消息 id**：渲染层 id 与检测键属不同键空间（文本消息检测键为 `0:正文`，渲染层为 msgIdServer/msgTime），混写会使已读房间在下一轮被误判为有新消息。删键后下一轮检测重新锚定，等价于「已读至当前」；
- **未读累加需单独触发落盘**：dirty 仅覆盖频道解析/首见锚定，遗漏将导致重启后未读数据丢失。

**未归属频道自愈**：`lastMsgList` 回包会出现同 server 下未登记的频道（解析失败的关注成员房间、暗号小房间、非成员互动频道），用 `im/team/room/info` 反查房主——`ownerId` 命中关注名单 → 补进归属表，下一轮生效；`ownerId = 0`（非成员房间）→ 负缓存按 TTL 重试；被暗号拦下（回包带 `questionId`）→ 判定为成员小房间，按「同 server 唯一关注成员」归属，新消息同样计入该成员未读。

持久化于 `userData/pocket48-unread.json`（SafeJSONFileSync 原子写 + 坏档回退）：频道解析结果（开销最高的环节）随水位一并落盘，重启不重解析、不丢未读。

## 8. 小房间与暗号门禁

小房间是成员主频道之外的暗号频道，与大房间同属一个 team server。

**频道发现**：`im/server/jump` 不返回小房间，它由主进程未读轮询在 `lastMsgList` 中发现，经 `room/info` 反查归属后写入 `pocket48-unread.json` 的 `smallChannels`，渲染层经 `pocketGetSmallChannel(userId)` 取用（见第 7 节）。故入口异步出现，未发现时不渲染页签。

**暗号题面**：暗号频道的 `room/info` 恒回业务码 `2001`，`message` 为内嵌 JSON 信封（题面来源）：

```json
{ "status": 2001, "success": false, "message": "{\"questionId\":\"986\",\"question\":\"层层最喜欢的数字！\"}" }
```

`2001` 与登录反爬问答同码（`CAPTCHA_STATUS`），`message` 需二次解析。

**作答校验**：`POST im/api/v1/team/channel/question/answer/verify`，body `{ answer, questionId }`。`questionId` 逐题校验：真实 id 配错答回 `{"status":500,"success":false,"message":"回答错误"}`，不存在或缺失 id 回「问题不存在」；`success: true` 即通过。

**锁态与解锁**：解锁状态只存渲染层内存（`unlockedSmallChannels`，`channelId` 为键），重启后重新校验。锁图标由 `smallRequiresAnswer` 判定（与当前视图无关，大房间视图下也常显），输入层由 `smallLocked`（= 小房间视图 && 未解锁）判定；校验失败一律停在锁定层。`MASTER_PASSCODE` 为自用通道（客户端直通、不发起请求），界面不公开。

**频道名**：`jump` 与 `lastMsgList` 均不带频道名，名称取自 seine 频道详情 `im/api/seine/server/detail`（`{ serverId }` → `channelInfoList[].channelName`），一次请求覆盖该 server 下全部频道；取不到时静默回退「房间 / 小房间」。seine 有独立的客户端特征，`seineHeaderOverrides()` 只覆盖 `appInfo` 与 `User-Agent`，`pa` 仍由 `postPocket` 现算。名称表连 `serverId` 一起存，读取时校验归属。

**界面落点**：频道切换置于 header 右侧（`.room-tab`，激活态用房间青 `--color-rooms`，锁图标常显，未读走全局 `.unread-badge` 数字角标）；消息范围置于消息区右上角（`.chat-tools` / `.scope-tab`，中性配色）。仅剩一条频道时整条页签栏不渲染（`roomTabs.length > 1`）。
