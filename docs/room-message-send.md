# 房间发送消息（QChat）

本文说明成员房间内「发言 / 回复 / 删除自己消息」与实时推送的协议链路和主进程会话设计。整体房间消息链路见 [room-message-pipeline.md](./room-message-pipeline.md)。

## 1. 架构概览

房间发言没有 HTTP 端点，只走网易云信 **QChat（圈组）** TCP 长连接；删除自己刚发的消息走 HTTP。

| 模块                                      | 职责                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `src/main/pocket48/nim-common.ts`         | varint / 属性表编解码 / RC4 / RSA 握手（与 `nim-chatroom.ts` 共用）  |
| `src/main/pocket48/nim-qchat.ts`          | QChat 协议客户端：LBS、NIM 登录、QChat 登录、订阅、收发、重连        |
| `src/main/pocket48/pocket-room-qchat.ts`  | 账号级会话复用、频道引用计数、发言冷却（`cdTime`）、精准投递与回显合成 |
| `src/main/pocket48/room-message-payload.ts` | 构造文本 / 回复报文与 `ext.user` 发言者资料快照                    |
| `src/renderer/src/composables/use-pocket-rooms.ts` | 串行同步订阅（`syncQChatChannel`）、发送/删除编排、冷却倒数镜像 |
| `src/renderer/src/pages/Rooms.vue`        | 输入条、发言阻断提示、按频道草稿暂存、右键回复/删除入口              |

## 2. 会话生命周期与连接策略

- **进房即常驻连接**：进入房间就绪后自动调用 `pocketRoomQChatEnter` 建连并订阅；`KeepAlive` 切去其他页面时保持连接常驻（切回房间页秒发消息、无重连延迟）。
- **先订新房再退旧房**：同一账号共用一条 QChat 连接（按 `accid` 索引），切换房间时串行执行「先订阅新频道，成功后再退订旧频道」，避免旧频道作为最后一条订阅被退掉时销毁整条连接。
- **并发与投递隔离**：
  - `ChannelState.subscribing` 复用同频道的在途订阅 Promise，防止并发进房提前返回 `ok`。
  - `pushBatch` 对 `kind === 'message'` 只投递给订阅了对应 `(serverId, channelId)` 的窗口；`kind === 'status'` 对同一 `WebContents` 去重后投递。
- **重连与失效清理**：
  - 网络断开后按退避自动重连，重连时轮询切换 `qchatAddresses` 候选地址，断开前通过 `destroySessions()` 释放旧会话引用；重连成功后按内部订阅表自动恢复频道。
  - 登出或 token 失效时调用 `resetRoomQChatSessions()` 销毁全部会话；应用退出时调用 `cleanupRoomQChatSessions()`。
- **凭据隔离**：`getImCredentials()` 仅在主进程内部调用，IM token 不出主进程。

## 3. QChat 协议与报文

### 3.1 连接步骤

| 步骤 | 动作                                               | 服务号 / 指令号                 | 说明                                                    |
| ---- | -------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| 1    | LBS 取接入地址 `lbs.netease.im/lbs/conf.jsp`       | —                               | 取 `common.link[0]`（不同于聊天室的 `lbs/chat.jsp`）    |
| 2    | NIM 登录                                           | `2` / `2`                       | 终端类型恒 `1`（AOS），客户端身份取自 `client-profile.ts` |
| 3    | 索取 QChat 服务器地址列表                          | `24` / `1`                      | 返回候选地址数组（重连时轮询使用）                      |
| 4    | QChat 登录                                         | `24` / `2`                      | 使用硬编码常量 `IM_APP_KEY` 与 `accid` / `imToken`      |
| 5    | 订阅频道（visitor 优先，403/404 回退普通订阅）     | `25`/`9` 或 `24`/`15`           | 心跳为 `1` / `2`（15s）                                 |

> 应答匹配必须同时比对 `serial` 与服务号/指令号，避免同 serial 的 `24/11` 推送顶替请求应答。

### 3.2 发送、回显与删除

- **发送（`24/10`）**：
  - 纯文本：`type = 0`，正文放 `body`（属性 10）。
  - 回复：`type = 100`，`body` 留空，`attachment`（属性 11）放 `{ replyInfo: { replyName, replyText, replyMessageId, text }, messageType: 'REPLY' }`。
  - `ext`（属性 12）：包含 `module: 'QCHAT'` 与从 `user/api/v1/user/info/reload` 拉取并缓存的 `user` 资料（不支持伪造他人身份）。
- **三源去重**：ACK 只回 `msgIdClient` / `msgIdServer` / 时刻，主进程用入参合成回显返回；ACK 回显、QChat `24/11` 推送与 HTTP 轮询共用归一化逻辑，按 `msgIdClient` 去重。ACK 回显不受「只看房主」过滤，保证自己发言立即可见。
- **删除自己消息（HTTP）**：`POST im/api/v1/team/msg/delete`（`{ accId, msgIdClient, channelId, msgTime }`），成功后本地立即摘除并保留去重键，防止传播延迟内被轮询写回。

## 4. 权限、冷却与 IPC 契约

- **发言阻断（`speakBlock`）**：
  - `unfollowed`：成员仅在本地关注或为临时房间（未在口袋账号关注），服务端不接受发言。
  - `muted`：`im/team/room/info` 的 `userFunction.sendText === false`（房间级或个人禁言），输入框直接展示禁言态并拦截点击。
- **发言冷却**：主进程进房时异步预热服务端 `cdTime`（常规房间 10s / 禁言房 30s），实际冷却取 `max(1500ms, cdTime)`；冷却起点在拉取发言资料完成后记录，发送失败即清零冷却。渲染层同步镜像倒数与禁用态。
- **IPC 通道**（`ipc-contract.d.ts` ↔ `preload/index.ts` ↔ `register-pocket-ipc.ts`）：
  - `pocketRoomQChatEnter(serverId, channelId)`
  - `pocketRoomQChatLeave(serverId, channelId)`
  - `pocketSendRoomMessage(serverId, channelId, text, reply?)`
  - `pocketDeleteRoomMessage(channelId, msgIdClient, msgTime)`
  - 推送事件：`pocketRoomBatch`（`status` | `message`）

## 5. 关键常量与端点速查

| 项           | 值                                                                 |
| ------------ | ------------------------------------------------------------------ |
| `IM_APP_KEY` | `632feff1f4c838541ab75195d1ceb3fa`                                 |
| IM 凭据      | `POST im/api/v1/im/userinfo`（`P-Sign-Type: V0`）                  |
| 发言者资料   | `POST user/api/v1/user/info/reload`（`{ from: 'appstart' }`）      |
| 房间权限     | `POST im/api/v1/im/team/room/info`（`userFunction.sendText`/`cdTime`） |
| 删除消息     | `POST im/api/v1/team/msg/delete`                                   |
| LBS（QChat） | `https://lbs.netease.im/lbs/conf.jsp`                              |
