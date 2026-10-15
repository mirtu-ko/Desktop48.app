# 房间消息链路

本文说明「房间」页的完整调用链路：从 Dock 入口到房间列表与消息流的渲染，
覆盖模块划分、跨进程边界、接口取舍与数据形态。

房间功能的数据结构与协议解析参考 [yk1z/yaya_msg](https://github.com/yk1z/yaya_msg)，
落地在 desktop48 既有管道上；与之对应的直播播放链路见《播放链路》（live-playback-pipeline.md），
两者互不依赖。

## 0. 设计前提

### 0.1 房间消息不是直播间弹幕

本项目并行存在**两套完全独立的消息体系**，接口、协议、渲染位置均不同，改动前需先区分：

| 维度       | 直播间弹幕                                   | 房间消息（本文）                                    |
| ---------- | -------------------------------------------- | --------------------------------------------------- |
| 产品形态   | 浮窗播放器里的实时互动                       | 口袋 App「房间」tab 的成员留言流                    |
| 传输方式   | 自研网易云信 TCP 长连接（`nim-chatroom.ts`） | HTTP 拉取 + 渲染层轮询                              |
| 入口       | 直播/回放独立播放窗                          | Dock「房间」→ `pages/Rooms.vue`                     |
| 数据源     | NIM 聊天室（`chatroomId`）                   | team server + channel（`im/server/jump` 解析）      |
| 实时性     | 长连接推送，秒级                             | 5s 轮询（见 5.2）                                   |
| 主进程模块 | `main/pocket48/pocket-danmaku.ts`            | `main/pocket48/pocket-auth.ts` + `pocket-unread.ts` |

参考实现 yaya_msg 的实时房间消息走 **QChat 长连接**（另一套 NIM 协议，需维护第二套
长连接客户端）。本版本以 5s 轮询替代实时推送：房间留言流时效要求远低于弹幕，
该粒度可满足查看需求，无需引入第二套长连接。

### 0.2 接口无文档，结构自参考实现推导

口袋48 的 im 域接口无官方文档，请求/回包结构均从参考实现交叉验证得出
（yaya_msg 为构造侧与解析侧双重参考，pocket-core / bot_48 等为旁证）。
字段名宽容匹配代码（`firstStr` 多候选键、`??` 兜底）即由此而来，
不应视为冗余代码删除。

### 0.3 token 存于主进程，链路跨进程

所有口袋接口经 `main/pocket48/pocket-auth.ts` 的 `postPocket` 发出：token 仅存于
主进程，请求使用 Electron `net.request`（规避渲染层 fetch 的 CORS 与系统代理问题）。
房间链路的每次数据交互均为一次 IPC：

| 角色     | 目录                                  | 职责                                     |
| -------- | ------------------------------------- | ---------------------------------------- |
| 渲染进程 | `pages/Rooms.vue`                     | 页面展示与交互（滚底、翻历史、媒体播放） |
| 编排层   | `composables/use-pocket-rooms.ts`     | 名单合并、频道遍历、消息拉取/轮询编排    |
| 预加载桥 | `src/preload/index.ts`                | 暴露 `window.mainAPI.pocketGetRoom*`     |
| 主进程   | `pocket-auth.ts` / `pocket-unread.ts` | 接口请求、未读检测（唯一真相）           |

IPC 契约按项目约定三处同步：`preload/ipc-contract.d.ts`（类型与 `InvokeSpec`）→
`preload/index.ts`（`satisfies mainAPI`）→ `main/ipc/register-pocket-ipc.ts`
（`handleTraced` 注册）。漏一处 `npm run typecheck` 直接失败。

## 1. 接口清单

全部位于 `pocketapi.48.cn`，均需登录 token：

| 用途                     | 端点                                      | 关键入参                                   | 回包要点                                            |
| ------------------------ | ----------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| 口袋关注 ID 列表         | `user/api/v1/friendships/friends/id`      | 无（token 即账号）                         | 纯 ID 数组，**不含**昵称/头像（需本地成员目录反查） |
| 成员 userId → 房间频道   | `im/api/v1/im/server/jump`                | `{ starId, targetType: 1 }`                | `{ serverId, channelId }`；解析不出 = 没有房间      |
| 批量取各频道最后一条消息 | `im/api/v1/team/classic/last/message/get` | `{ serverIdList: number[] }`               | `lastMsgList`：每频道一条，`msgTime` 实测恒为 0     |
| 房间消息（只看成员）     | `im/api/v1/team/message/list/homeowner`   | `{ channelId, serverId, nextTime, limit }` | `message` + `nextTime` 游标；混入官方账号 121569667 |
| 房间消息（全部用户）     | `im/api/v1/team/message/list/all`         | 同上                                       | 同上                                                |

## 2. 调用链路总览

### 2.1 首灌（进页面 / 手动刷新）

```
[Rooms.vue]  onMounted → load()（keep-alive 页面只挂载一次；重新进入走 onActivated → refreshRoomStatus(false)）
     │        未登录：整页登录引导，不发任何口袋接口请求（仅一次本地登录态读取）
     ▼
[use-pocket-rooms.ts]  load()
     ├─ refreshPocketAuthState()   等登录态落库（同步返回旧值+异步刷新，冷启动首帧会误判未登录）
     ├─ loadFollowedIds()          口袋关注 ID ∪ 本地关注 ID（并集，只增不删）
     │      pocketGetFollowedIds 失败 → pocketFollowError 提示，降级为本地名单
     ├─ fetchLiveMap(true)         共享 live-status store（120s 缓存，force 参数强制刷新）
     ├─ 成员目录反查               头像/昵称/队伍（接口不返回这些；查不到降级「口袋用户 N」）
     ├─ resolveRooms(entries)      有界并发 5 遍历 im/server/jump
     │      ├─ 解析失败/空频道 → 过滤（无房间，含已关闭），计入 hiddenRoomCount
     │      └─ 成功 → 写入 channelCache（userId → 频道）
     │      全部解析异常（接口故障）→ 整页 loadError + 重试按钮，不展示空列表
     └─ fetchLastMessageMap(...)   一次批量请求获取全部频道最新一条 → 左列预览
            ▼
      rooms.value（在直播的排前，其余按昵称 localeCompare('zh')）
```

### 2.2 选中房间与轮询

```
[Rooms.vue]  @click="selectRoom(room.userId)"
     ▼
[use-pocket-rooms.ts]  selectRoom(userId)
     ├─ clearChat()                选中序号 ++（在途回包作废，防消息串房）+ 复位游标/去重键
     ├─ channelCache 命中 → 直接用；未命中（关注后新增）才懒解析 jump
     ├─ fetchRoomPage(channel, 0, 'replace')
     │      pocketGetRoomMessages(channelId, serverId, nextTime=0, scope)
     │      → normalizePocketRoomMessage 逐条归一（DELETE 类返回 null 过滤）
     │      → mergeMessages(replace)：接口 msgTime 倒序 → 翻转为时间升序
     │      → historyCursor = nextTime（0 = 没有更多）
     └─ chatStatus='ready' → resumeMessagePoll()

轮询（useIntervalFn，5s，随页面激活态暂停/恢复）：
     pollRoomMessages() → fetchRoomPage(activeChannel, 0, 'append')
     └─ 只追加没见过的新消息（messageKeys 去重），并同步左列预览到最新一条

翻历史（贴顶自动 / 按钮）：
     loadMoreHistory() → fetchRoomPage(activeChannel, historyCursor, 'prepend')
```

## 3. 各阶段数据形态

### ① 关注名单（并集）

```js
// loadFollowedIds() 返回：number[]
// = 口袋账号关注 ∪ 本地关注（member-flags store，含桌面端手动关注）
```

并集策略（只增不删）：本地关注为桌面端用户的主观行为，口袋接口失败或账号
未登录时不得清除；反向同步（本地新增 → 双写口袋）见成员页「关注」实现。

### ② 房间条目 `PocketRoom`

```js
const room = {
  userId: 10001,
  nickname: '陈琳', // 成员目录反查；查不到降级「口袋用户 10001」
  avatar: 'https://source.48.cn/mediasource/xxx.jpg',
  teamName: 'SNH48 TEAM SII',
  teamColor: '8EC9E8',
  serverId: '2881', // 首灌遍历 jump 解析，写入 channelCache
  channelId: '55667788',
  preview: '[回复 甲] 不客气～', // 左列预览：批量最新消息归一（空串 = 暂无消息）
  previewTime: 1728000000000, // 预览对应消息时刻：防旧快照覆盖更新的本地预览
  live: null, // 匹配到的在播直播；留言流与直播与否无关，未开播也可查看
}
```

### ③ 房间频道 `PocketRoomChannel`

```js
// im/server/jump 回包 content
const channel = { serverId: '2881', channelId: '55667788' }
```

两者为空串表示该成员没有房间（未开通，或已关闭/被回收——关闭的房间同样解析不出
频道，见第 4 节）。`targetType: 1` 固定值。

### ④ 原始消息 `PocketRoomMessage`（CustomMessageV2）

```js
const raw = {
  msgIdServer: '...',
  msgIdClient: '...', // 去重键首选
  msgType: 'REPLY', // 决定正文语义，见第 6 节分发表
  msgTime: 1728000000000,
  bodys: '{"replyInfo":{...},"messageType":"REPLY"}', // 多为 JSON 字符串
  extInfo:
    '{"user":{"userId":...,"nickName":...,"avatar":...,"level":...,"roleId":...}}',
}
```

### ⑤ 归一化消息 `PocketRoomMessageView`

`utils/pocket-room-message.ts` 输出，消息流、引用块、相册、语音条、分享卡共用：

```js
const view = {
  id: 'msgIdClient', // msgIdClient || msgIdServer || msgTime（轮询/翻历史去重键）
  kind: 'reply', // text/image/audio/video/reply/flip/live/gift/vote/system
  text: '不客气～', // 本条正文（回复类 = 回复自己的话，被引用内容在 quote）
  userId: '10002',
  nick: '成员乙',
  avatar: '...',
  level: 26,
  isMember: true, // roleId > 1 = 成员（xox）
  msgTime: 1728000000000,
  quote: {
    // 仅回复类；null = 非回复消息
    nick: '成员甲',
    text: '翻个牌',
    isGift: false, // 被引用的是礼物消息（giftInfo 摘要）
  },
  imageUrl: '',
  imageWidth: 0,
  imageHeight: 0, // 图片直链 + 原始尺寸（aspect-ratio 占位）
  audioUrl: '',
  videoUrl: '',
  videoPoster: '', // 音视频直链 + 封面
  liveId: '',
  liveType: 0,
  liveMode: 0, // 直播分享目标（SHARE_LIVE 等）
  liveStartTime: 0,
  liveCover: '',
  liveIsPlayback: false,
}
```

### ⑥ 批量最新消息 `PocketRoomLastMessage`

```js
// team/classic/last/message/get 回包 lastMsgList 元素
const last = {
  channelId: '55667788',
  serverId: '2881',
  starName: '...', // 此为「最后发言人」而非房主
  msgContent: '{"messageType":"TEXT","text":"晚安"}',
  msgKey: 'xxx', // 消息身份键：msgidClient 优先，最后退 msgTime:msgContent
  msgTime: 0, // ⚠️ 实测恒为 0，不可作时间轴（见第 7 节）
  unreadCount: 3,
}
```

### ⑦ 未读快照 `PocketUnreadBatch`

```js
const batch = { rooms: { 10001: { count: 3, latestTime: 0 } }, total: 3 }
```

主进程唯一真相的全量镜像，渲染层只读；变化经 `pocketUnreadBatch` 广播到所有窗口。

## 4. 房间可用性判定：只认 jump 解析

列表过滤的唯一依据是 `im/server/jump` 能否解析出频道：

- 接口抛错（网络/业务失败）→ 按无房间过滤，计入 `hiddenRoomCount`，左列显示
  「已隐藏 N 个」；
- 接口成功但 `serverId`/`channelId` 为空 → 同样按无房间过滤；
- **全部成员解析异常**时整页报错——此时为接口故障而非确实无房间，
  展示错误与重试入口而非静默空列表。

⚠️ **不应将 `im/team/room/info` 的 `channelStatus` 作为关闭判据**。
该字段语义不明：实测正常房间同样返回非 0（曾据「非 0 = 已关闭」过滤，
导致全部房间被误过滤）；真正关闭的房间在 jump 阶段即解析不出频道，
已由上述路径覆盖。`room/info` 现仅用于未读检测的频道归属反查（`getRoomChannelOwner`）。

## 5. 消息拉取：倒序、游标、轮询

### 5.1 三种拉取模式统一入口

`fetchRoomPage(channel, nextTime, mode)` 统一处理三种数据流，接口始终按
`msgTime` 倒序（最新在前）返回：

| mode      | 触发场景     | nextTime | 合并方式                     |
| --------- | ------------ | -------- | ---------------------------- |
| `replace` | 选中房间首屏 | 0        | 翻转为时间升序，整体替换     |
| `prepend` | 翻更早历史   | 游标     | 排序后插到头部               |
| `append`  | 轮询新消息   | 0        | 去重后排序追加，同步左列预览 |

- 去重键 `messageKeys`：`msgIdClient || msgIdServer || msgTime`，轮询与翻历史共用；
- `historyExhausted` **仅认 `nextTime === 0`**——本页条数不足 limit 不表示已到末页
  （服务端分页策略不透明，曾按条数判断导致更早历史无法拉取）；
- 轮询增量的预览同步按消息时刻比较（`previewTime`），防止批量预览的旧快照
  覆盖更新的本地预览。

### 5.2 轮询节奏与生命周期

- 间隔 5s（参考实现通知轮询为 2s，取值平衡实时性与接口压力）；
- 仅选中房间就绪后启动；`onDeactivated` 暂停、`onActivated` 恢复——
  主窗口页面走 keep-alive，切页不销毁，**需以激活态控制定时器**，
  仅挂 `onMounted` 时切页后仍在后台运行；
- 失焦窗口被 Chromium 节流定时器，但房间页在主窗口内不受影响
  （需要后台持续渲染的独立播放窗才必须 `backgroundThrottling: false`）。

### 5.3 消息范围与官方账号

`homeowner`（只看成员）/ `all`（全部用户）两档，切换即重拉当前房间。
`homeowner` 会混入口袋官方系统账号 `121569667`，渲染层按 `userId` 过滤。

## 6. 消息归一化

`utils/pocket-room-message.ts` 是整个房间链路的协议层，与弹幕归一化
（`pocket-chat-message.ts`）是两份独立实现，不共用代码。

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

未识别类型不丢弃：`extMsgType` 动态消息（POST_INFO 等）使用兜底文本，为空时显示 `[新消息]`。
协议侧语音类型名是 `AUDIO` 不是 `VOICE`（bot_48 / yaya_msg 一致）。

### 6.2 发送者资料

主路径 `extInfo.user`（userId/nickName/avatar/level/roleId），顶层字段兜底。
`roleId > 1` 判定成员（昵称着色 + 「房主」标签）。userId 需宽松数字强转——
接口对纯数字 ID 返回 number 与 string 不定。

### 6.3 引用块：replyInfo 的字段语义

⚠️ 易错字段（曾因语义颠倒导致引用内容丢失、回复正文错显）：

- `replyInfo.text` = **本条回复自己的正文**（构造侧 `buildReplyOptions` 的 text 即回复语）；
- `replyInfo.replyText` = **被引用消息的文本**；
- `replyInfo.giftInfo` = 被引用的是礼物消息时，摘要走 `[礼物] 名 xN` 并标金。

引用块（昵称行与气泡之间）为**只读展示**，不提供点击跳转：被引用消息往往不在
当前列表（更早历史未拉到 / 被范围过滤 / 原消息已删）。
`replyMessageId` 字段仍在协议中，本版本不解析。

### 6.4 左列预览复用同一套分发

`normalizePocketRoomPreview(msgContent)` 与消息流共用 `messageText`，
两侧文案一致。左列单行无法容纳引用块，回复类预览以「回复 昵称」前缀保留上下文；
回复无正文时退回被引用内容。

## 7. 未读检测（主进程唯一真相）

`main/pocket48/pocket-unread.ts`，与任务列表（task-registry → stores/tasks）
同一套「主进程真相 + 各窗镜像」模式：页面没开、窗口最小化时未读照常积累
（定时器在主进程，不受 Chromium 失焦节流影响）。

### 7.1 单轮检测流程

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
  ├─ healChannelOwners()  未归属频道自愈（见 7.3）
  └─ 落盘 + broadcastIpc('pocketUnreadBatch') + app.setBadgeCount
```

### 7.2 实现约束

- **回执键按 `channelId` 存**，不按 userId——同一成员存在大房间与小房间两个频道，
  按 userId 存储会相互覆盖；
- **markRead 只删回执键，不接受渲染层消息 id**：渲染层 id 与检测键属不同键空间
  （文本消息检测键为 `0:正文`，渲染层为 msgIdServer/msgTime），混写会使已读房间
  在下一轮被误判为有新消息。删键后下一轮检测重新锚定，等价于「已读至当前」；
- **未读累加需单独触发落盘**：dirty 仅覆盖频道解析/首见锚定，遗漏将导致
  重启后未读数据丢失。

### 7.3 未归属频道自愈

`lastMsgList` 回包会出现同 server 下未登记的频道（解析失败的关注成员房间、
暗号小房间、非成员互动频道）。用 `im/team/room/info` 反查房主：

- `ownerId` 命中关注名单 → 补进归属表，下一轮生效；
- `ownerId = 0`（非成员房间）→ 负缓存按 TTL 重试；
- 被暗号拦下（回包带 `questionId`）→ 判定为成员小房间，按「同 server 唯一关注
  成员」归属，小房间新消息同样计入该成员未读。

持久化于 `userData/pocket48-unread.json`（SafeJSONFileSync 原子写 + 坏档回退）：
频道解析结果（开销最高的环节）随水位一并落盘，重启不重解析、不丢未读。

## 8. 页面交互与滚动

### 8.1 高度与滚动容器

`.rooms-page` 直接复用全局 `.page-root`（`height: 100%`），padding 须配合
`box-sizing: border-box`——本项目无全局 reset，缺失时整页高出视口约 110px，
滚动转移至 `.app-content`，表现为页面整体滚动。修复后：**整页不滚动，
仅左栏房间列表与右栏消息流两处内部滚动**（`detail-scroll`）。

### 8.2 滚底策略

| 场景         | 行为                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 切换房间     | 强制回底（新房间无既有滚动位置）                                        |
| 同房新消息   | 仅当已贴底（< 48px）时回滚至底部；上翻浏览不受打断，仅累计浮标计数      |
| 翻更早历史   | 保持视口：`scrollTop += 插入高度增量`，视觉位置不变                     |
| 媒体加载完成 | 仍贴底则补一次贴底（图片/视频加载前高度为 0，会使视口偏离底部）         |
| 贴底浏览     | 视同已读：`markRoomRead` 主进程清零未读并广播，左列与 Dock 角标同步消失 |

上翻浏览时不标记已读，未读保留。

## 9. 失败降级

| 失败点               | 行为                                                 |
| -------------------- | ---------------------------------------------------- |
| 口袋关注拉取失败     | 降级本地名单 + 左列一行提示，列表照常                |
| 频道解析失败（单人） | 按无房间过滤，计入 hiddenRoomCount                   |
| 频道解析全部异常     | 整页报错 + 重试（区分接口故障与真空列表）            |
| 批量最新消息失败     | 无预览降级，房间照常可用                             |
| 消息拉取/轮询失败    | 右侧消息区报错；轮询失败静默（下一轮自愈）           |
| 直播状态拉取失败     | 无 LIVE 角标；留言流与直播与否无关，不影响查看       |
| token 失效           | **唯一不降级路径**：异常上抛，整页报错并引导重新登录 |

## 10. 链路验证方法

### 10.1 debug 日志（首选）

scope 对照表登记在 `utils/debug.ts` 头部：

| scope          | 覆盖场景                                                   |
| -------------- | ---------------------------------------------------------- |
| `pocket-rooms` | 编排层：名单合并、频道遍历、消息拉取/轮询/翻历史、降级分支 |
| `rooms-page`   | 页面层：列表加载完成、选中态与消息数、滚底相关状态         |

主进程侧对照 `[pocket-auth]`（接口请求/回包，含 lastMsgList 原始首条）与
`[pocket-unread]`（单轮检测全流程）输出。打开方式：

- 渲染层：`import.meta.env.DEV` 门控，`npm run dev` 即输出（`[DBG]` 前缀）；
- 主进程：`is.dev` 门控，开发模式运行即可；IPC 层由 `handleTraced` 自动记录
  通道名/参数摘要/耗时/错误。

### 10.2 关键断点位置

| 位置                                                          | 观察内容                               |
| ------------------------------------------------------------- | -------------------------------------- |
| `composables/use-pocket-rooms.ts` → `load`                    | 关注并集、直播匹配、频道遍历与过滤计数 |
| `composables/use-pocket-rooms.ts` → `selectRoom`              | 频道缓存命中/懒解析、回包复核防串房    |
| `composables/use-pocket-rooms.ts` → `mergeMessages`           | 三种 mode 的合并与去重、预览同步       |
| `utils/pocket-room-message.ts` → `normalizePocketRoomMessage` | msgType 分发、quote 解析、媒体直链     |
| `main/pocket48/pocket-unread.ts` → `tick`                     | 单轮检测：锚定/计数/自愈/落盘          |
| `pages/Rooms.vue` → `onListScroll`                            | 贴底判定、自动翻历史与视口保持         |

### 10.3 真机核对清单

1. 登录后 Dock「房间」：列表出现、未读角标与 Dock 总数一致；
2. 未开通/已关闭房间不出现在列表，左列「已隐藏 N 个」计数正确；
3. 选中房间：消息流按时间升序、贴底显示最新；
4. 上翻自动拉更早历史且视口不跳动；「只看成员 / 全部」切换后消息范围正确；
5. 图片/语音/视频/分享卡可正常播放，分享卡点击按在播与否分流直播/回放窗；
6. 贴底浏览后未读清零；切到别的页面 60s 后收到新消息，角标重新出现。
