# 播放链路

本文说明直播播放的完整调用链路：从列表页点击卡片，到视频画面渲染，
其间涉及的模块、跨进程边界、安全闸门与数据形态变化。建议在阅读具体实现前先通读本文。

## 0. 设计前提

48 官方下发的直播地址为 `rtmp://` 协议，浏览器内核不支持直接播放。因此需要经过一次转封装：

```
rtmp://（官方源）  →  FFmpeg 转封装  →  http://127.0.0.1（本地）  →  <video> 可播放
```

FFmpeg 为外部可执行程序，只能由主进程 spawn。这一约束决定了单次播放必然跨进程，
也是整条链路复杂度的根本来源。

涉及的三个运行环境：

| 角色     | 目录                   | 职责                                               |
| -------- | ---------------------- | -------------------------------------------------- |
| 渲染进程 | `src/renderer`         | Vue 页面与播放器 UI                                |
| 预加载桥 | `src/preload/index.ts` | 将主进程能力暴露为 `window.mainAPI.*`              |
| 主进程   | `src/main`             | 本地 HTTP 服务、FFmpeg 进程管理、白名单/端口安全闸 |

主进程侧的关键分工（改动前请先看清）：

- `main/stream.ts` — 只导出**纯业务函数** `handleCreateLiveStream` / `handleStopLiveStream` /
  `cleanupStreamSessions` / `createFlvStreamProcess`，**不直接**调用 `ipcMain.handle`。
- `main/ipc/register-stream-ipc.ts` — 唯一的 IPC 接线处，通过 `ipc/trace.ts` 的 `handleTraced`
  包装注册（记录通道名/参数摘要/耗时/错误）。所有 invoke 通道由 `ipc/index.ts` 的
  `registerAllIPC()` 统一入口挂载。
- `main/http-server.ts` — 本地回环 HTTP 服务，端口区间 8080–8090，被占则退避；
  播放器 GET `/live/:id.flv` 时才真正 spawn FFmpeg。
- `main/allowed-hosts.ts` — `isAllowedStreamUrl` 白名单（rtmp/http 分别声明后缀），
  任何交给 ffmpeg 的 URL 都必须先过它。

## 1. 调用链路总览

以公演页点击进行中的公演为例。个人直播链路与此一致，仅在获取详情一步分叉。

```
[Shows.vue]  @click="openLiveStream(show)"
     │        show → payload（结构转换），仅 status===2 才继续
     ▼
[stores/float-players.ts]  openLive(payload) → openPlayer('live', payload)
     │        模块级单例数组，跨页面共享；同 liveId 已存在时 focusPlayer 置顶复用
     ▼  （Vue 响应式自动触发，不存在显式的弹窗调用）
[FloatPlayerHost.vue]  v-for="item in players"
     ▼
[FloatPlayer.vue]  窗口外壳：拖拽 / 三态尺寸 / z-index
     │        payload 展开为 props
     ▼
[LivePlayer.vue]  onMounted → resumeLive() → session.getLiveOne()
     ▼
[use-live-session.ts]  getLiveOne()
     ├─ onSessionStart()      复位 loading 与重试计数（LivePlayer.beginSession）
     ├─ ① fetchLiveDetail()
     │      source==='open' → Apis.openLive()  → pickPreferredStream(playStreams) 选高清
     │      source==='user' → Apis.live()      → 单档 rtmp 地址
     │      得到远程源地址 "rtmp://live-play.48.cn/..."
     ├─ applyLiveDetail()     同步封面/主播名/头像/电台轮播/在线人数
     │
     └─ ② restartLiveStream(rtmpUrl)
            ├─ onBeforeRebuild()   清重试计时器 + 销毁播放器 + 复位媒体元素
            ├─ stopCurrentLiveStream()  先停旧会话（等主进程确认）
            └─ startLiveStream()
                    → window.mainAPI.createLiveStream(rtmpUrl, liveId)
                    ===== 进程边界 =====
                 [preload/index.ts]             ipcRenderer.invoke
                 [main/ipc/register-stream-ipc] handleTraced 包装
                 [main/stream.ts] handleCreateLiveStream
                    ├─ assertLocalServerAvailable()  端口全被占则抛错（IPC 回传弹窗）
                    ├─ isAllowedStreamUrl(rtmpUrl)   白名单校验，拒绝非 48 域
                    └─ 仅将 rtmp 地址登记入 streamSessions Map，**不启动 FFmpeg**
                 ← 返回 "http://127.0.0.1:<port>/live/xxx.flv"
            写入 localPlaybackUrl（buildPlaybackUrl 附加 ?t=<时间戳>&r=<重启序号>）
     ▼  （watch localPlaybackUrl immediate:true 触发）
[use-live-player.ts]  mountPlayer() → mpegts.createPlayer(localPlaybackUrl)
     │        发起 HTTP GET
     ▼
[main/http-server.ts]  命中 /live/xxx.flv
     │        Origin 校验（'null' / file:// / dev-server 才放行）
     │        FFmpeg 于此刻 spawn（createFlvStreamProcess）
     │        ffmpeg -i rtmp://... -c copy -f flv pipe:1
     └─ ffmpeg.stdout.pipe(res)
     ▼
mpegts 解析 FLV → MSE → <video> 渲染 → oncanplay → 加载态解除
```

## 2. 各阶段数据形态

### ① 列表项 `OpenLive`（`getOpenLiveList` 返回）

```js
const show = {
  liveId: '68a3f1c2b4e5d60012345678',
  title: 'BEJ48 TEAM B 《梦想的旗帜》',
  subTitle: '2026年9月5日 19:00 公演',
  coverPath: 'https://source.48.cn/mediasource/xxx.jpg',
  status: 2, // 1=未开始 2=进行中 4=已结束
  stime: '1757070000000', // 字符串类型
  teamList: [{ teamId: 12, teamName: 'BEJ48 TEAM B', teamColor: '00BFFF' }]
}
```

### ② `FloatPlayerPayload`（经 `Shows.vue` 的 `openLiveStream` 转换）

```js
const payload = {
  liveId: '68a3f1c2b4e5d60012345678',
  nickname: 'BEJ48 TEAM B',
  title: '2026年9月5日 19:00 公演',
  startTime: 1757070000000, // 已转为数字
  source: 'open', // 决定后续调用哪个详情接口
  avatar: 'https://source.48.cn/mediasource/xxx.jpg',
  liveType: 1, // 1=视频，其它=电台（纯音频）
  liveMode: 0
}
```

`payload` 在后续三层中原样透传（数组项 → FloatPlayer → LivePlayer props），
可作为追踪整条链路的线索。

### ③ `players` 数组（模块级单例）

```js
const players = [
  { id: 'fp-m0x8k2-0', kind: 'live', payload, order: 1 }
]
```

`stores/float-players.ts` 对外暴露 `openLive` / `openPlayback` 两个语义入口，
内部都走 `openPlayer(kind, payload)`；同 `liveId` 已存在时直接 `focusPlayer`
把它移到数组末尾（z-index 取数组下标，实现置顶）而**不新建**。

### ④ 详情归一化结果 `LiveDetail`

公演接口返回 `playStreams` 数组（含多档清晰度），个人直播接口返回单个地址。
`fetchLiveDetail` 将两者归一为同一结构，后续代码无需区分数据来源：

```js
const detail = {
  playStreamPath: 'rtmp://live-play.48.cn/live/xxx_hd', // 契约字段名，远程地址
  coverPath: '/mediasource/xxx.jpg',
  user: { userName: '2026年9月5日 19:00 公演', userAvatar: '' }, // 公演无主播信息，以标题兜底
  liveId: '68a3f1c2b4e5d60012345678',
  onlineNum: 1234, // 仅 source==='user' 存在
  carousels: { carousels: ['...'], carouselTime: 5000 } // 仅电台模式使用
}
```

`applyLiveDetail` 消费它，把界面状态（封面/主播名/头像/电台轮播）与在线人数
（`onOnlineNum` 上抛给 `use-live-polling`）分别写到对应的 ref。

### ⑤ 主进程返回值

```js
const result = {
  url: 'http://127.0.0.1:8080/live/68a3f1c2b4e5d60012345678.flv',
  liveId: '68a3f1c2b4e5d60012345678'
}
```

写入 `localPlaybackUrl` 时经 `buildPlaybackUrl(url, restartToken)` 附加
`?t=<时间戳>&r=<重启序号>`，确保每次地址唯一，避免浏览器或 mpegts 复用既有连接。

## 3. 两类地址的区分

`use-live-session.ts` 中存在两个与地址相关的量，方向相反，需注意区分：

| 变量                        | 内容                         | 方向                       |
| --------------------------- | ---------------------------- | -------------------------- |
| `LiveDetail.playStreamPath` | `rtmp://live-play.48.cn/...` | 输入：供主进程 FFmpeg 拉流 |
| `localPlaybackUrl`          | `http://127.0.0.1:8080/...`  | 输出：供 mpegts 播放器加载 |

前者为接口契约字段，定义于 `services/api-types.ts`，不可更名；
后者为内部状态，已命名为 `localPlaybackUrl` 以示区别。

## 4. FFmpeg 的延迟启动机制

需要特别说明：`handleCreateLiveStream` 本身并不启动 FFmpeg。

```
handleCreateLiveStream → assertLocalServerAvailable + isAllowedStreamUrl
                       → 仅向 streamSessions Map 写入 { liveId → rtmpUrl }，返回本地地址
播放器 GET 本地地址    → http-server 查 Map 取出 rtmpUrl → createFlvStreamProcess 才 spawn
```

采用延迟启动的收益：若浮窗创建后立即关闭，不会遗留无用的 FFmpeg 进程；
多次点击同一直播（`existingSession.inputUrl === rtmpUrl`）时直接复用会话，
不重复登记。

## 5. 关闭时的资源回收

回收路径为双向，渲染进程与主进程各自独立兜底：

```
关闭浮窗 → players 移除条目 → LivePlayer.onUnmounted
   ├─ session.dispose()       置 isDisposed + 递增令牌失效 + stopStreamNow
   ├─ retry.clearTimer()      清重试计时器
   ├─ polling.stopAll()       停轮询
   ├─ player.destroyPlayer()  销毁 mpegts 实例 + 复位媒体元素
   └─ releaseSleepBlocker()   释放防休眠

同时 HTTP 连接断开 → http-server 的 req/res close → SIGKILL FFmpeg（响应级）
主进程 handleStopLiveStream → stopProcess(优雅写 'q')
   └─ 2 秒未退出 → SIGTERM，再失败 → SIGKILL（会话级兜底）
应用退出 → app.ts before-quit → cleanupStreamSessions() 清空全部会话与进程
```

任一侧异常均不会导致 FFmpeg 进程泄漏。

## 6. LivePlayer.vue 中 composable 的协作关系

该文件是本项目耦合度最高的模块，共挂载 7 个 composable。其中**前 4 个之间存在环状引用**，
依靠 JavaScript 函数声明提升（hoisting）解决实例化顺序问题——因此
`useLiveSession({ onBeforeRebuild: rebuildMedia, onSessionStart: beginSession })`
中引用的两个 handler 定义于文件更靠后的位置，此为有意为之。

```
              ┌─────────────────────────────────────┐
              │                                     │
  session ──onSessionStart──▶ beginSession ──▶ retry.reset() + mediaLoading=true
  session ──onBeforeRebuild─▶ rebuildMedia  ──▶ retry.clearTimer() + player.destroyPlayer()
  session ──onAvatar/onOnlineNum/onUnavailable─▶ 上报浮窗头 / 写入 polling / 广播下架+关窗
  player  ──onCanPlay───────▶ onPlayerCanPlay ─▶ retry.isRecoveringStream=false
  player  ──onError─────────▶ handleStreamError ─▶ 网络错保持 loading / 致命错销毁播放器 → retry.schedule()
  retry   ──attempt─────────▶ recoverStream  ──▶ session.fetchLiveDetail + applyLiveDetail + restartLiveStream
  retry   ──onExhausted─────▶ handleRetryExhausted ─▶ session.stopStreamNow + EventBus 'live-unavailable' + emit('close')
              │                                     │
              └─────────────────────────────────────┘
```

建议的阅读顺序：先读 `beginSession`、`rebuildMedia`、`handleStreamError`、
`onPlayerCanPlay`、`recoverStream`、`handleRetryExhausted` 六个 handler，
再回看 `useXxx({...})` 的参数。

职责划分如下：

| composable           | 负责范围                                         | 不负责范围                      |
| -------------------- | ------------------------------------------------ | ------------------------------- |
| `use-live-session`   | 拉详情、开/停本地转流会话、界面状态同步          | 播放器实例、重试节奏、轮询      |
| `use-live-player`    | mpegts 实例创建/销毁、媒体元素复位               | 地址来源、错误处理策略          |
| `use-stream-retry`   | 重试节奏（默认 2 秒 × 3 次，决策走纯函数）       | 具体恢复逻辑（由 attempt 注入） |
| `use-live-polling`   | 已播时长、在线人数定时刷新                       | 播放行为本身                    |
| `use-video-rotation` | 旋转 / 容器全屏 / 原生 PiP / 播放暂停 / 音量     | 地址、重试                      |
| `use-sleep-blocker`  | 播放期间阻止系统休眠                             | 播放行为                        |
| `use-media-download` | 录制发起（走原始 RTMP 直存文件，不经本地转封装） | 页面播放链路                    |

## 7. 四处需要注意的实现约定

### 7.1 composable 参数采用 getter 而非值

```ts
useLiveSession({ liveId: () => props.liveId }) // 正确
useLiveSession({ liveId: props.liveId }) // 错误：传入的是快照
```

直接传值会在调用瞬间固化，props 的后续变化无法在 composable 内感知。
传入 getter 则可保证每次读取均为最新值。

### 7.2 播放器重建统一由 watch 驱动

`getLiveOne()` 在获取地址后可直接调用 `setupPlayer(地址)`，但实现上改为
`watch(localPlaybackUrl, ..., { immediate: true })`。这样首次播放、断流重试、
恢复播放三类场景均归并为「写入地址」这一动作，播放器重建逻辑仅存在于一处；
`immediate: true` 让首挂载（地址已有缓存值时）也走同一条路径。

### 7.3 递增令牌 `activeStreamRequestId` + `streamRestartToken`

连续两次点击同一场直播时，第一次请求持有 `requestId=1`，第二次将计数推进至 2。
第一次的迟到响应返回时，检测到 `requestId(1) !== activeStreamRequestId(2)`，
即判定自身已过期，主动 `stopLiveStream` 撤销刚登记的会话并放弃写入，
不覆盖第二次的结果。分页列表中的 `listRequestId`（`use-paged-list.ts`）采用相同模式。

`streamRestartToken` 是另一个维度的递增序号，拼进播放地址的 `?r=` 参数，
让同 URL 的两次重启在浏览器/mpegts 眼里是两个不同资源，避免复用旧连接。

### 7.4 详情失败统一走 `onUnavailable`

`getLiveOne` 的 `try/catch` 里，详情接口失败通常意味着直播已下架。
错误提示由 `services/request.ts` 的 `Apis.request` 统一弹窗（网络/非 JSON/业务
失败三类，3 秒同文案去重），此处**不重复弹**，只广播
`EventBus.emit('live-unavailable', liveId)` 让列表页刷新，然后 `emit('close')`
关掉浮窗。重试耗尽走的是同一条下架路径（见 `handleRetryExhausted`）。

### 7.5 上游推流中断（连麦等）只能从媒体元素侧感知

主播开始/停止连麦时，官方会换发新签名：仅 query 里的 `wsSecret` / `wsTime` 变化，
Stream Key 不变。旧地址随即失效 → 主进程 FFmpeg 退出 → 本地 FLV 响应结束。

这条路径上**没有任何 mpegts ERROR 事件**，重试状态机不会被触发，因此恢复入口必须自己建立：

- 本地响应没有 `Content-Length`，mpegts 判定为「下载完成」（LOADING_COMPLETE）而非 Early-EOF，
  不抛 ERROR；随后 `endOfStream()` 把时长校正到最后一段，浏览器播完缓冲即触发 `ended`
  （伴随 `pause`，所以画面看起来是「停住 + 变暂停」，再点播放也无法继续）。
- 触发点取媒体元素的 `onended`（见 `use-live-player.ts`）：直播正常播放时永远不会 ended，
  故一律按网络错误上抛 → `retry.schedule()` → `recoverStream` 重新拉详情拿到**新签名地址**重建。
- ⚠️ 不要改用 mpegts 的 `LOADING_COMPLETE` 兜底：`enableWorker: true` 时 worker 回传的包只有
  `{ msg, event }`、不带 `extraData`，主线程按 `'extraData' in packet` 判断后直接丢弃该事件。
- 重试计数语义是「连续失败次数」，必须在 canplay 时清零（`retry.markRecovered()`）：
  否则一场直播里累计断流 3 次（连麦很容易做到）就会被误判为「直播已结束」并关窗。

## 8. 对照：历史公演（回放）链路

同一 Shows 页面中，点击历史公演走 `openHistoryStream` → `openPlayback(payload)`
→ `PlaybackPlayer`：

```
PlaybackPlayer
  ├─ usePlaybackEngine     sourcePath 变化时按后缀选 hls.js 或原生 <video> 直接加载
  │                        维护 loading / buffering / error 三态，事件全部 onXxx 回调
  └─ usePlaybackDanmaku    按当前播放时间推进弹幕游标（onTimeUpdate / onSeeking）
```

该链路不涉及 FFmpeg 与本地 HTTP 服务，因为 VOD 地址（http 协议的 m3u8/mp4）
浏览器可直接播放。与直播链路对照阅读，有助于理解后者引入转封装的必要性。

## 9. 链路验证方法

### 9.1 debug 日志（首选）

三条播放链已埋讲解型 debug 日志，scope 对照表登记在 `utils/debug.ts` 头部：

| scope      | 覆盖场景                                   |
| ---------- | ------------------------------------------ |
| `live`     | LivePlayer 直播链（阶段编号 ①②…）          |
| `show`     | Shows.vue 按 `status` 分流到直播/回放      |
| `playback` | PlaybackPlayer 录播链（hls.js / 原生 MP4） |

打开方式：

- 渲染层：`import.meta.env.DEV` 门控，`npm run dev` 即输出（走 `console.log` 带 `[DBG]` 前缀，
  故意不用 `console.debug`——后者默认被 DevTools Verbose 过滤器隐藏）。
- 主进程：`is.dev || process.env.DESKTOP48_VERBOSE === '1'` 门控，
  生产环境用 `DESKTOP48_VERBOSE=1` 启动即可打开。
- IPC 层：`main/ipc/trace.ts` 的 `handleTraced` 包装所有 invoke 通道，
  自动记录通道名/参数摘要/耗时/错误，无需业务代码埋点。

### 9.2 关键断点位置

| 位置                                                             | 观察内容                         |
| ---------------------------------------------------------------- | -------------------------------- |
| `pages/Shows.vue` → `openLiveStream`                             | 原始 `show` 数据与 status 分流   |
| `stores/float-players.ts` → `openPlayer`                         | `players` 数组变化与去重置顶     |
| `composables/use-live-session.ts` → `fetchLiveDetail`            | 归一化后的详情与 rtmp 地址       |
| `composables/use-live-session.ts` → `startLiveStream`            | 主进程返回的本地地址             |
| `main/stream.ts` → `handleCreateLiveStream`                      | 白名单校验与会话登记             |
| `main/http-server.ts` → 请求 handler（`createFlvStreamProcess`） | FFmpeg 实际 spawn 时机与首帧到达 |

执行 `npm run dev` 后打开 DevTools，在 `getLiveOne()` 处设断点并逐步步进，
调用栈面板会完整呈现链路及各变量的实时取值，较通读源码更为直观。
