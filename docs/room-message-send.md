# 房间发送消息

现状：已在桌面端实现「房间发言 / 回复 / 删除自己刚发的消息」，默认不连接、点聊天框确认后才连接（见第 3 节）。
参考实现：[yk1z/yaya_msg](https://github.com/yk1z/yaya_msg) 的「发送消息：在成员口袋房间中发送消息」功能。

> 参考实现的解析与本文档结构对齐 `docs/room-message-pipeline.md`（房间消息链路）。两者互不依赖。

## 0. 结论速览

1. **没有 HTTP 发送端点**。房间发言只存在于网易云信 **QChat（圈组）** 协议里，走 TCP 长连接。已实测 12 个候选 HTTP 路径（`im/api/v1/team/msg/send`、`/team/message/send`、`/team/msg/create`、`/team/msg/publish` …）全部返回 404；`pocketapi.48.cn` 也无 swagger 文档可查。
2. **yaya_msg 的做法**：主进程维护一条 QChat 长连接，订阅目标频道后用 `sendMessage` 发；发完用返回的 `msgIdClient` 走 HTTP 删/撤。
3. **本项目可复用的零件有两样**：IM 凭据（`getImCredentials()`，拿 `accid` + `imToken`，正是 QChat 登录所需）与一套 NIM 私有协议栈（`main/pocket48/nim-chatroom.ts`）。但**聊天室与 QChat 是两个协议族**（service 13 vs 24/25），连接逻辑不能直接复用，只能复用编解码工具（varint / 属性表 / RC4）。
4. **代价**：新增一个约 500–600 行的 QChat 客户端 + 主进程会话管理 + 渲染层输入条，约等于「把弹幕那套协议再做一遍」。
5. **已实现**：发送 / 回复 / 删除自己刚发的消息，以及默认不连接、确认后才连接的输入条（第 3、4 节）。并且**不建议**照搬 yaya_msg 的「自定义发言身份」功能（第 1.6 节）。
6. **同一账号无法两端同时在线**：桌面端建连会顶掉手机端同账号的登录，客户端参数改不了，唯一解是换账号。**因此房间页默认不连云信**（只看，不挤手机），点聊天框并确认后才建连、才可发言（第 3 节）。

## 1. 参考实现怎么做的

### 1.1 进程分层

```
渲染层  followed-chat-feature.js   输入框 / 回复态 / 乐观回显 / 连接状态
   │ ipcRenderer.invoke('connect-member-room' | 'send-member-room-message' | 'delete-member-room-message')
   ▼
主进程  member-room-service.js     每窗口一条连接，connectionId 绑定，防串房
   │  service  member-room-transport.js   同 appKey+account 的连接共享（多频道订阅复用一条）
   ▼
协议层  nim-commonlink-qchat.js     QChat 客户端：握手 / 登录 / 订阅 / 收发
```

`main/ipc/member-room-ipc.js` 暴露 5 个通道：`connect-member-room`、`disconnect-member-room`、`send-member-room-message`、`delete-member-room-message`、`fetch-member-room-gift` / `send-member-room-gift`。

### 1.2 QChat 连接建立

协议是云信 **commonlink** 私有协议，帧结构与本项目的聊天室客户端一致（varint 长度 + 5 字节头 + body，body 可 zlib 压缩，头 bit1 带结果码），但**服务号与流程完全不同**：

| 步骤 | 动作                                                                               | 服务号/指令号                   | 备注                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1    | LBS 取接入地址 `https://lbs.netease.im/lbs/conf.jsp`（`k`/`id`/`v`/`tp=1`/`dt=0`） | —                               | 与聊天室用的 `lbs/chat.jsp` 是两个端点，回包取 `common.link[0]`                                                                     |
| 2    | **NIM 登录**（拿 NIM 会话）                                                        | `2` / `2`                       | 属性：**3=终端类型**（恒 1=AOS，与两个官方 App 一致）、13=deviceId、18=appKey、19=account、25=包名、40/42=SDK 版本与 UA、1000=token |
| 3    | 在 NIM 会话上**索取 QChat 地址**                                                   | `24` / `1`                      | body = 属性表 `{1:0}`，回包是字符串数组                                                                                             |
| 4    | **QChat 登录**                                                                     | `24` / `2`                      | 属性：1=appKey、2=account、3=authType(0)、4=token、6=1、8=deviceId、9=SDK 版本、11=UA、14=SDK 人读版本                              |
| 5    | **订阅频道**（visitor 优先，403/404 再退普通订阅）                                 | `25`/`9`（visitor）或 `24`/`15` | body = 属性表 `{1: visitor?6:1, 2: subscribe?1:2}` + varint(1) + 属性表 `{1: serverId, 2: channelId}`                               |
| 6    | 心跳                                                                               | `1` / `2`                       | 15s                                                                                                                                 |

要点：

- **appKey 是两个 APK 共用的硬编码常量**：`632feff1f4c838541ab75195d1ceb3fa`，直接写进 `SDKOptions.appKey`（pocket 在 `NIMStrategy.getOptions()`，seine 在 `e4/p.configIM()`），`im/userinfo` 不下发，也没有条件替换逻辑。`PhoneConfig.imKey` **不是** appKey，它是消息防伪盐 `md5(uuid + fromAccount + imKey)`。本项目直接用常量 `IM_APP_KEY`。
- **一次连接可订阅多频道**：`member-room-transport.js` 按 `appKey:account` 复用会话，维护订阅表（上限 100 频道），离开房间只退订不重连。
- **收发共用一条**：实时消息推送在 `24` / `11`。
- **同一账号只能一端在线**：`2/2` 是账号级登录，建连会顶掉同账号的其他设备（手机端），客户端参数无法规避，只能换账号。故房间页默认不建连（第 3 节）。

### 1.3 发送报文

纯文本（`type='text'`，落到属性 9 = 0）：

```
属性表 {
  1: serverId, 2: channelId, 3: fromAccount(=accid),
  9: 0,                  // 0=文本 100=自定义
  10: 正文,              // body
  12: ext(JSON),
  13: msgIdClient,       // 客户端生成的 UUID
  20: mentionAll, 21: 'QChat',
  100: historyEnable, 101: pushEnable, 102: needBadge,
  103: needPushNick, 105: routeEnable
}
```

回复某条（`type='custom'`，落到属性 9 = 100）——正文走 `attachment`（属性 11），`body` 留空：

```json
{
  "replyInfo": { "replyName": "…", "replyText": "被回复正文", "replyMessageId": "…", "text": "本条正文" },
  "messageType": "REPLY"
}
```

`ext` 是发言者资料快照（口袋客户端自己拼的）：

```json
{
  "module": "QCHAT",
  "channelRole": "0",
  "bubbleId": "0",
  "user": {
    "userId": "…",
    "nickName": "…",
    "avatar": "…",
    "level": 0,
    "roleId": 0,
    "vip": false,
    "pfUrl": "",
    "teamLogo": "",
    "badge": []
  }
}
```

这份 `user` 来自 `user/api/v1/user/info/reload`（yaya 的 `login-check-token` 通道）。注意 `roleId`、`level`、`vip`、`badge` 等字段——本项目现有的 `pickUserInfo()` 只取 `nickname`/`avatar`/`userId`，发消息需要扩。

发送侧的三条业务规则：

- **冷却 1500ms**（`SEND_INTERVAL_MS`）：超了直接拒「发送太快，请稍后再试」；发送失败会把冷却清零。这只是客户端的点击防抖，**不是**官方冷却——真正的限流是服务端房间级 `cdTime`（`room/info` 的 `userFunction`，常规房间 10s、禁言房 30s），别把 1.5s 当节奏上限去用。
- **目标校验**：serverId/channelId 必须仍是当前会话订阅的频道，否则「房间连接已失效，请重新进入房间」。
- **连接失效**：token 变更、连接断开都要求重连后重试。

**回显三源去重**：发送 ACK 只回 `msgIdClient` / `msgIdServer` / 时刻，正文与发言者资料由主进程用发送入参合成一条回显返回；它与 `24/11` 推送、HTTP 轮询回包共用同一归一化，按 `msgIdClient` 去重，哪条先到都只显示一次。ACK 回显不受消息范围过滤（发送就要有回音），推送那条则照常过范围过滤。

### 1.4 删除自己发的消息（这条是 HTTP）

```
POST https://pocketapi.48.cn/im/api/v1/team/msg/delete
{ accId, msgIdClient, channelId, msgTime }
```

只能删自己账号发的（服务端按 `accId` 校验）。`accId` 就是 IM 的 `accid`。

### 1.5 同一套「发送」家族里的其它能力（都是 HTTP，与房间发言不同链路）

| 能力     | 端点                                              | 说明                                                                                                                                    |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 翻牌提问 | `POST idolanswer/api/idolanswer/v1/user/question` | 向成员提问；撤回/删除走 `/user/question/operate`                                                                                        |
| 口袋私信 | `POST message/api/v1/user/message/reply`          | 目标 `targetUserId`，`messageType` TEXT/IMAGE                                                                                           |
| 房间送礼 | `POST gift/api/v1/gift/send`                      | `businessCode=5`、`businessId=serverId`、`sendToRoomId=channelId`；先查 `im/api/v1/im/team/room/info` 的 `userFunction.sendGift` 判权限 |
| 屏蔽词表 | `GET home/api/check/maskword`                     | 词表在远端 txt，客户端需自行下载并匹配                                                                                                  |

**「发言」不在 HTTP 这一列**——这是本次调研最关键的一条。

### 1.6 参考实现有、但本项目不建议抄的

yaya_msg 有「自定义发言身份」（`common/sender-profile.js`）：把 `nickName`、`avatar`、`level`、`roleId`、`channelRole`、`bubbleId`、`monthCardBadge` 全部改成用户自定义，也就是**在房间里冒充别人（含成员）发言**。这是风控与合规上的雷区（易被判定为伪造身份、封号），desktop48 不应实现。

## 2. 实现前的差距（对照表）

| 维度       | 本项目现状                                                         | 目标                                                  | 缺口                                                                                           |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 收房间消息 | HTTP 轮询 5s（`use-pocket-rooms.ts`）                              | 同上 + 连接后的 QChat 实时推送                        | 已实现（推送 / ACK / 轮询共用一条消息流）                                                      |
| 频道标识   | 已有 `serverId` / `channelId`（`im/server/jump` + seine 频道列表） | 同上                                                  | 无需动                                                                                         |
| IM 凭据    | `getImCredentials()` → `accid` + `imToken`                         | 同上                                                  | 无需动（token 仅在主进程，天然合规）                                                           |
| appKey     | `IM_APP_KEY` 常量（两个 APK 硬编码同值）                           | 同上                                                  | 无需动                                                                                         |
| 协议栈     | `nim-chatroom.ts`（service 13 聊天室，直播弹幕用）                 | QChat（service 24/25 圈组）                           | **需新增** `nim-qchat.ts`（约 500–600 行）；建议把 varint/属性表/RC4 抽成 `nim-common.ts` 共用 |
| 发消息     | 无                                                                 | QChat `24/10`                                         | **需新增**主进程会话服务 + IPC                                                                 |
| 删自己消息 | 无                                                                 | HTTP `im/api/v1/team/msg/delete`                      | 需新增（依赖上一条）                                                                           |
| 回复某条   | 无                                                                 | QChat `24/10` + `attachment.replyInfo`                | 需新增                                                                                         |
| 消息身份   | 归一化后只留 `id`（`msgIdClient‖msgIdServer‖msgTime`）             | 回复/删除需要 `msgIdClient` + `msgTime`               | 需在 `PocketRoomMessageView` 补两个字段                                                        |
| 发言者资料 | `pickUserInfo()` 取 3 个字段                                       | `ext.user` 需要 level/roleId/vip/pfUrl/teamLogo/badge | 需扩展取字段（`user/api/v1/user/info/reload`）                                                 |
| 发言权限   | 未知                                                               | 房间是否允许粉丝发言？被禁言/关聊天？                 | **待验证**（见第 5 节）                                                                        |
| 屏蔽词     | 无                                                                 | 口袋侧有屏蔽词表                                      | 可选：发前本地校验                                                                             |
| 发言冷却   | —                                                                  | 官方 App 有冷却                                       | 建议 1.5s（与参考实现一致）                                                                    |

## 3. 方案取舍

### 已采用：按需连接 + 首次确认

进房只跑 5s HTTP 轮询，**不建立 QChat 连接**。用户点聊天输入框时弹出确认：

> 发言需要以当前账号连接云信，同一账号只允许一台设备在线。连接后，手机或其他设备上正在登录的口袋48会被顶下线，需要重新打开。

确认后才建连（`2/2 → 24/1 → 24/2 → 订阅`）并允许发送；取消则保持只看不连，浏览与轮询不受影响。确认态在本窗口内有效，登出即复位。

- **收益**：只是浏览房间不占用云信会话，手机端不会被顶；后果在动作发生前说清楚，不让人莫名掉线。
- **代价**：未连接期间没有实时推送（退回轮询）；连接后手机端会被顶下线，这一半无法消除。
- **主动断开**：连接确认后输入条左侧出现「断开连接」按钮，点击退出 QChat（撤销授权、退订频道、销毁连接），回到只看模式；不需要等登出 / 关窗口才释放手机端。

### 约束：同一账号不能两端同时在线

桌面端建连即以当前账号登录云信，手机端同账号会被顶下线。客户端参数无法规避，唯一解是换账号（换 `accid`）。这属于产品决策，不需要改协议层——`getImCredentials()` 按当前登录账号取凭据，换账号即换 accid。

### 不做：自定义发言身份

理由见第 1.6 节（冒充他人发言）。

## 4. 落点清单（已落地）

按 desktop48 现有分层（对照 `docs/room-message-pipeline.md` 的跨进程约定）：

**主进程**

- `main/pocket48/nim-common.ts`（新）：varint / 属性表编解码 / RC4 / RSA 握手——从 `nim-chatroom.ts` 抽出共用，两套协议各留自己的登录与帧语义。
- `main/pocket48/nim-qchat.ts`（新）：QChat 客户端（连接、订阅、收发、属性表构造）。
- `main/pocket48/pocket-room-qchat.ts`（新）：会话管理（按账号复用连接、频道订阅表、冷却、目标校验）、`sendRoomMessage` / `deleteRoomMessage`。
- `main/pocket48/pocket-auth.ts`：扩展用户资料取字段（`level`/`roleId`/`vip`/`pfUrl`/`teamLogo`/`badge`），供 `ext.user` 使用。
- `common/pocket-api-urls.ts`：新增 `ROOM_MSG_DELETE_URL`（`im/api/v1/team/msg/delete`）。

**IPC 契约（项目约定三处同步：ipc-contract.d.ts → preload/index.ts → register-pocket-ipc.ts）**

- `pocketSendRoomMessage(channelId, serverId, text, reply?)`
- `pocketDeleteRoomMessage(channelId, serverId, msgIdClient, msgTime)`

**渲染层**

- `utils/pocket-room-message.ts`：`PocketRoomMessageView` 增 `msgIdClient` / `msgTime`（保留原 `id` 不变，兼容去重键）。
- `composables/use-pocket-rooms.ts`：暴露 `sendMessage` / `deleteOwnMessage`，维护发送态（发送中/冷却/错误），发送成功后乐观插入。
- `pages/Rooms.vue`：聊天区底部加输入条（`el-input` + 发送钮），回复态（引用摘要 + 取消），未登录 / 小房间锁态不可用；房间禁言时不隐藏输入条，只换占位文案并拦在点击前（建连会白顶一次手机端）。

**测试**（`test/`，纯逻辑优先）

- QChat 发送属性表构造（纯函数断言，含回复态 attachment 结构）。
- 冷却与目标校验。
- 归一化补字段后 `normalizePocketRoomMessage` 的 id 不变。

## 5. 已确认与仍待观察

**已确认**

1. **发言链路可用**：QChat `2/2 → 24/1 → 24/2 → 24/10` 打通，发送、回复、删除自己刚发的消息均已实现；删/撤走 HTTP `im/api/v1/team/msg/delete`。
2. **登录身份档位**：QChat 与聊天室统一报当前档位的 SDK 版本与包名；终端类型恒 1（AOS），与两个官方 App 一致。
3. **`im/userinfo` 回包只有 `accid/pwd/userId`**：不下发 appKey，同一账号恒定返回同一 accid。
4. **两个档位是同一个账号**：pocket48 与 seine48 实测 `accid` 与 `userId` 完全相同。
5. **连接会让同账号的其他设备下线**，故默认不连、确认后才连（第 3 节）。
6. **房间发言权限取自 `team/room/info` 的 `userFunction.sendText`**（2026-10 实测，账号「海市」对照 7 个房间）：
   - 「增锅的房间🍳」1311973（房主开了**房间级全员禁言**）：`sendText / sendGif / sendEmoticon / sendForward` 全 `false`，`cdTime = 30`；
   - 同期其余 6 个房间（陈琳 / 杨心渝 / 张雷雷 / 盛乐 / 李婷 / 吉雅楠）`sendText = true`，`cdTime = 10`；
   - 同一账号两种结果 → 这是**房间级限制**，不是账号被封；
   - `inTeamServer` / `roomRole` 在两组的取值完全相同（`false` / `"0"`），**不能**作为判据；
   - 结论：客户端不要自己推导规则，直接读 `sendText`（服务端已把等级、身份组、房间设置、个人禁言合并进去）。渲染层据此在输入框常驻禁言提示，并**在点击前就拦住 QChat 建连**（否则会白顶一次手机端）。

**仍待观察**

1. **解除禁言如何感知**：`DISABLE_SPEAK` 是消息流里的系统消息，可作「变为禁言」的即时信号；但解除禁言没有对应通知，目前只在进房 / 切频道时重拉一次 `sendText`。
2. **服务端是否对发言做额外校验**（屏蔽词、等级门槛、风控）。

## 6. 风险

- **风控 / 封号**：桌面端模拟官方客户端发言本身是敏感行为（参考实现即如此）。建议：单账号发言频率保守、失败即停，不做自动重试风暴，不做批量。
- **协议漂移**：口袋客户端升级可能改 appKey / SDK 版本 / 报文属性，届时 QChat 登录会被拒。表现应是「连接失败」而非「发送被拒」，错误文案需区分二者。
- **不要把 IM token 出主进程**（本项目现状已符合：`getImCredentials` 无 IPC 通道，token 不出主进程）。
- **不要实现身份伪装**（第 1.6 节）。

## 附：关键端点与常量速查

| 项           | 值                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| QChat appKey | `632feff1f4c838541ab75195d1ceb3fa`（两个 APK 硬编码同值，`im/userinfo` 不下发）→ `IM_APP_KEY`                                                                            |
| IM 凭据      | `POST im/api/v1/im/userinfo`，头带 `P-Sign-Type: V0` → `content.accid` + `content.pwd`                                                                                   |
| 用户资料     | `POST user/api/v1/user/info/reload`（`{ from: 'appstart' }`）                                                                                                            |
| 删消息       | `POST im/api/v1/team/msg/delete`                                                                                                                                         |
| 房间信息     | `POST im/api/v1/im/team/room/info`（`{ channelId }`）                                                                                                                    |
| LBS（QChat） | `https://lbs.netease.im/lbs/conf.jsp`（聊天室是 `lbs/chat.jsp`）                                                                                                         |
| 发言冷却     | 客户端 1500ms（`SEND_INTERVAL_MS`，点击防抖）；服务端房间级 `cdTime`：常规 10s / 禁言房 30s                                                                              |
| 服务号/指令  | NIM 登录 `2/2`；取 QChat 地址 `24/1`；QChat 登录 `24/2`；订阅 `25/9`\|`24/15`；发消息 `24/10`；实时推送 `24/11`；心跳 `1/2`                                              |
| 应答匹配     | 应答帧回填请求自己的 `serial` **与** 服务号/指令号（实测 `24/10`、`25/9`）；`serial` 每条连接独立从 2 起，故匹配须连 s/c 一起比，否则同 serial 的 `24/11` 推送会顶替应答 |
