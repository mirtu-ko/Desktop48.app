# 播放链路

本文说明直播播放的完整调用链路：从列表页点击卡片到视频画面渲染，覆盖模块划分、跨进程边界、安全闸门与数据形态。

## 0. 设计前提

48 官方下发的直播地址为 `rtmp://`，浏览器内核不支持直接播放，因此需要一次转封装：

```
rtmp://（官方源） → FFmpeg 转封装 → http://127.0.0.1（本地） → <video> 可播放
```

FFmpeg 为外部可执行程序，只能由主进程 spawn。该约束决定了单次播放必然跨进程，也是整条链路复杂度的根本来源。

| 角色     | 目录                   | 职责                                                 |
| -------- | ---------------------- | ---------------------------------------------------- |
| 渲染进程 | `src/renderer`         | Vue 页面与播放器 UI                                  |
| 预加载桥 | `src/preload/index.ts` | 将主进程能力暴露为 `window.mainAPI.*`                |
| 主进程   | `src/main`             | 本地 HTTP 服务、FFmpeg 进程管理、白名单/端口安全闸门 |

主进程侧分工（改动前先看清）：`main/stream.ts` 只导出纯业务函数（`handleCreateLiveStream` / `handleStopLiveStream` / `cleanupStreamSessions` / `createFlvStreamProcess`），不直接调用 `ipcMain.handle`；`main/ipc/register-stream-ipc.ts` 是唯一接线处，经 `ipc/trace.ts` 的 `handleTraced` 包装注册，全部 invoke 通道由 `ipc/index.ts` 的 `registerAllIPC()` 统一挂载；`main/http-server.ts` 是本机回环 HTTP 服务（端口 8080–8090，被占则退避），播放器 GET `/live/:id.flv` 时才真正 spawn FFmpeg；`main/allowed-hosts.ts` 的 `isAllowedStreamUrl` 是白名单，任何交给 FFmpeg 的 URL 都必须先过它。

## 1. 调用链路总览

以公演页点击进行中的公演为例；个人直播链路除详情接口分叉外一致。

```
[Shows.vue] @click="openLiveStream(show)"
   │  show → payload（结构转换），仅 status === 2 才继续
   ▼
[stores/float-players.ts] openLive(payload)
   │  薄封装：只把页面意图转成一次 IPC 调用，自身不持有状态
   │  checkLiveReady()（use-live-guard）：FFmpeg 未就绪则提示并跳设置页，不开必然空转的窗口
   ▼ openPlayer('live', payload) → window.mainAPI.openFloatWindow(kind, payload)
   ===== 进程边界 =====
[main/float-window.ts] openFloatWindow
   ├─ Map<`${kind}:${liveId}`> 去重：已存在 → restore/show/focus 复用
   └─ 否则 new BrowserWindow（frame:false / alwaysOnTop）→ `#/float?kind=..&liveId=..`
   ▼
[独立窗口渲染进程] main.ts 按 hash 分流 → mount(FloatWindowApp)
   │  floatPlayerGetPayload(kind, liveId) 回取全量载荷 → 展开为 props
   ▼
[LivePlayer.vue] onMounted → resumeLive() → session.getLiveOne()
   ▼
[use-live-session.ts] getLiveOne()
   ├─ onSessionStart()  复位 loading 与重试计数
   ├─ fetchLiveDetail()
   │    source==='open' → Apis.openLive() → pickPreferredStream(playStreams) 选高清
   │    source==='user' → Apis.live()     → 单档 rtmp 地址
   ├─ applyLiveDetail()  同步封面/主播名/头像/电台轮播/在线人数
   └─ restartLiveStream(rtmpUrl)
        ├─ onBeforeRebuild()  清重试计时器 + 销毁播放器 + 复位媒体元素
        ├─ stopCurrentLiveStream()  先停旧会话
        └─ startLiveStream() → createLiveStream(rtmpUrl, liveId)
             ===== 进程边界 =====
           [main/stream.ts] handleCreateLiveStream
             ├─ assertLocalServerAvailable()  端口全被占则抛错
             ├─ isAllowedStreamUrl(rtmpUrl)   白名单校验，拒绝非 48 域
             └─ 仅登记 { liveId → rtmpUrl } 入 streamSessions，**不启动 FFmpeg**
           ← "http://127.0.0.1:<port>/live/xxx.flv"
        写入 localPlaybackUrl（经 buildPlaybackUrl 附加 ?t=<时间戳>&r=<重启序号>）
   ▼ （watch localPlaybackUrl immediate:true 触发）
[use-live-player.ts] mountPlayer() → mpegts.createPlayer(localPlaybackUrl) → HTTP GET
   ▼
[main/http-server.ts] 命中 /live/xxx.flv
   │  Origin 校验（'null' / file:// / dev-server 才放行）
   │  createFlvStreamProcess 于此刻 spawn：ffmpeg -i rtmp://... -c copy -f flv pipe:1
   └─ ffmpeg.stdout.pipe(res)
   ▼
mpegts 解析 FLV → MSE → <video> → oncanplay → 加载态解除
```

### 1.1 独立播放窗

直播 / 回放打开的是真正的 Electron 独立窗口，可拖出应用窗口之外。

| 关注点   | 实现                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 窗口创建 | `main/float-window.ts` 的 `openFloatWindow`，`frame:false` + `alwaysOnTop`；以 `kind:liveId` 去重，重复点击只聚焦不新建；标题栏整条 `-webkit-app-region: drag` 交给系统，无自研拖拽代码                                                                                                       |
| 页面复用 | 与主窗口共用 `index.html`；`renderer/src/main.ts` 按 hash 是否以 `FLOAT_WINDOW_HASH_PATH` 开头分流                                                                                                                                                                                            |
| 载荷传递 | hash 只带 `kind` + `liveId`，全量载荷由主进程持有、播放窗经 `floatPlayerGetPayload` 回取，窗口 reload 后可自愈                                                                                                                                                                                |
| 缩放     | 系统边框自由缩放；`@aspect` 到达时按工作区整体重算（非只保宽度），保持右上角不动。**首次定形无条件执行**：建窗用 9:16 兜底，此时「实际尺寸 ≠ 请求值」是常态（DPI、WM 取整），据此判定用户缩放过会让首次定形被整个跳过，横屏视频停在竖屏窄窗；定形落定后才尊重用户缩放（判据 `decideAutoFit`） |
| 最大化   | 标题栏自带按钮（`maximizable: true`），双击标题栏同效，属系统级最大化。状态由主进程经 `sendIpc` 推 `windowOnMaximizeChange`（各窗口独立，不可广播）；最大化视同用户接管尺寸                                                                                                                   |
| 初始尺寸 | 按所在显示器工作区比例自适应：宽 = 工作区宽 × 0.45（横屏决定项），高上限 = 工作区高 × 0.7（竖屏决定项），按视频比例内接后叠加标题栏（`computeInitialWindowSize`）。`workArea` 为 DIP，4K@200% 与 1080p@100% 观感一致                                                                          |
| 电台窗   | 固定竖屏 `FLOAT_RADIO_WINDOW_SIZE`（360×640），不参与比例推导——电台无视频轨、永不上报 aspect。判据 `payload.liveType === 2`；回放的 `liveType` 由 `Playbacks.vue` 透传，不能等 `PlaybackPlayer` 拉详情                                                                                        |
| 置顶     | 播放中置顶（播放状态变化 → `setAlwaysOnTop`），暂停 / 结束取消；创建时先置顶。层级为默认 `floating`（在任务栏之下），要盖住全屏应用需改 `screen-saver`                                                                                                                                        |
| 生命周期 | 关闭主窗口 → `closeAllFloatWindows()` + `cleanupStreamSessions()` → `window-all-closed` 触发退出；播放窗的 `live-unavailable` 经 `notifyLiveUnavailable` 上报主进程再转发主窗口 EventBus                                                                                                      |
| 任务状态 | 下载 / 录制任务列表是主进程注册表的镜像，**每个窗口都要 `installTasks()`**；`Started`/`End`/`Error` 广播给全部窗口，`Progress` 只回发起方                                                                                                                                                     |

尺寸常量集中在 `src/common/float-window.ts`（主进程与渲染端共用）；播放窗须 `backgroundThrottling:false`，否则失焦时 Chromium 默认节流 rAF/定时器，弹幕与轮询会卡顿。

⚠️ 窗口控制通道一律以 `BrowserWindow.fromWebContents(event.sender)` 定位窗口，不能恒取主窗口——否则播放窗的关闭按钮会关掉主窗口。

⚠️ **平台差异（Linux）**：`will-resize` / `resized` 只有 macOS / Windows 触发，`fitFloatWindowAspect` 另有一道兜底——尺寸偏离「上次程序设置的尺寸」超 2px 即视为用户缩放，且该兜底**只在首次定形落定后生效**，否则建窗时的 DPI / WM 偏差会被误判成用户缩放，使首次定形被跳过。Wayland 下 `setSize` / `setPosition` / `setAlwaysOnTop` 不保证被合成器采纳，初始 x/y 可能失效（尺寸定形通常仍生效，未做分支）。`closeAllFloatWindows()` 用 `destroy()`，**不触发 `unload`**，渲染端 `stopLiveStream` 不会执行，故转流进程由 `http-server.ts` 的 `req.on('close')` SIGKILL 兜底、`streamSessions` 由 `cleanupStreamSessions()` 清理——macOS 关主窗口不退出应用，该步骤须挂在主窗口 `closed` 而非仅 `before-quit`。

## 2. 各阶段数据形态

**① 列表项 `OpenLive`**（`getOpenLiveList`）：`{ liveId, title, subTitle, coverPath, status /* 1未开始 2进行中 4已结束 */, stime /* 字符串 */, teamList: [{ teamId, teamName, teamColor }] }`。

**② `FloatPlayerPayload`**（`Shows.vue` 转换）：在 ① 基础上将 `stime` 转数字，并补 `source`（`'open' | 'user'`，决定详情接口）、`liveType`（1 视频 / 其它电台）、`bilibiliRoomId`（仅公演携带，映射不到则缺省，播放器不显示弹幕入口）。载荷在后续三层（数组项 → FloatPlayer → LivePlayer props）原样透传。

**③ 播放窗记录**（主进程 `records`，键为 `kind:liveId`）：`{ win, payload, aspectFitted, userResized }`。`stores/float-players.ts` 对外只暴露 `openLive` / `openPlayback` 两个语义入口。

**④ 详情归一化 `LiveDetail`**：公演接口返回 `playStreams` 多档清晰度、个人直播返回单地址，`fetchLiveDetail` 归一为同一结构（`playStreamPath` / `coverPath` / `user` / `liveId` / `onlineNum`（仅 user）/ `carousels`（仅电台）），后续代码不再区分来源；`applyLiveDetail` 消费它写界面状态，在线人数经 `onOnlineNum` 上抛 `use-live-polling`。主进程返回 `{ url /* http://127.0.0.1:.../live/xxx.flv */, liveId }`。

## 3. 两类地址的区分

| 变量                        | 内容                         | 方向                       |
| --------------------------- | ---------------------------- | -------------------------- |
| `LiveDetail.playStreamPath` | `rtmp://live-play.48.cn/...` | 输入：供主进程 FFmpeg 拉流 |
| `localPlaybackUrl`          | `http://127.0.0.1:8080/...`  | 输出：供 mpegts 播放器加载 |

前者为接口契约字段（`services/api-types.ts`），不可更名；后者为内部状态。

## 4. FFmpeg 的延迟启动

`handleCreateLiveStream` 本身不启动 FFmpeg：它只做闸门校验并登记 `{ liveId → rtmpUrl }`，返回本地地址；播放器 GET 本地地址时 `http-server` 才取出地址并 spawn。收益：播放窗创建后立即关闭不会遗留 FFmpeg 进程；同一直播（`existingSession.inputUrl === rtmpUrl`）复用会话，不重复登记。

## 5. 关闭时的资源回收

回收路径双向，渲染进程与主进程各自独立兜底：

```
关闭播放窗 → 窗口销毁 → LivePlayer.onUnmounted
   ├─ session.dispose() / retry.clearTimer() / polling.stopAll()
   └─ player.destroyPlayer() / releaseSleepBlocker()
HTTP 连接断开 → http-server 的 req/res close → SIGKILL FFmpeg（响应级）
handleStopLiveStream → stopProcess(优雅写 'q') → 2s 未退 SIGTERM → 再失败 SIGKILL（会话级）
应用退出 → before-quit → cleanupStreamSessions() 清空全部会话与进程
```

任一侧异常均不导致 FFmpeg 进程泄漏。

## 6. LivePlayer.vue 中 composable 的协作

该文件是耦合度最高的模块，共挂载 9 个 composable，其中 session / retry / player / recoverStream 存在环状引用，依靠函数声明提升解决实例化顺序——因此 `useLiveSession({ onBeforeRebuild: rebuildMedia, onSessionStart: beginSession })` 引用的两个 handler 定义于文件更靠后的位置，此为有意为之。

```
session ──onSessionStart──▶ beginSession ──▶ retry.reset() + mediaLoading=true
session ──onBeforeRebuild─▶ rebuildMedia ──▶ retry.clearTimer() + player.destroyPlayer()
session ──onAvatar/onOnlineNum/onUnavailable─▶ 标题栏 / polling / 下架+关窗
player  ──onCanPlay───────▶ onPlayerCanPlay ──▶ retry.isRecoveringStream=false
player  ──onError─────────▶ handleStreamError ──▶ 网络错保持 loading / 致命错销毁播放器 → retry.schedule()
retry   ──attempt─────────▶ recoverStream ──▶ fetchLiveDetail + applyLiveDetail + restartLiveStream
retry   ──onExhausted─────▶ handleRetryExhausted ──▶ stopStreamNow + 'live-unavailable' + emit('close')
```

建议阅读顺序：先读 `beginSession` / `rebuildMedia` / `handleStreamError` / `onPlayerCanPlay` / `recoverStream` / `handleRetryExhausted` 六个 handler，再回看 `useXxx({...})` 的参数。

| composable           | 负责                                                        | 不负责                               |
| -------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `use-live-session`   | 拉详情、补拉聊天室 ID、开/停转流会话、界面状态同步          | 播放器实例、重试节奏、轮询、弹幕订阅 |
| `use-live-player`    | mpegts 实例创建/销毁、媒体元素复位                          | 地址来源、错误处理策略               |
| `use-stream-retry`   | 重试节奏（默认 2s × 3，决策走纯函数）                       | 具体恢复逻辑（由 attempt 注入）      |
| `use-live-polling`   | 已播时长、在线人数定时刷新                                  | 播放行为本身                         |
| `use-video-rotation` | 旋转 / 容器全屏 / 播放暂停 / 音量                           | 地址、重试                           |
| `use-sleep-blocker`  | 播放期间阻止系统休眠                                        | 播放行为                             |
| `use-media-download` | 录制发起（走原始 RTMP 直存文件，不经本地转封装）            | 页面播放链路                         |
| `use-live-danmaku`   | 双源弹幕订阅与投放                                          | 播放行为、气泡层渲染                 |
| `use-danmaku-layer`  | 弹幕层锚定与摆放（画面内 / 左侧黑边）、字号自适应、宽度上限 | 弹幕内容与生命周期                   |

弹幕层的几何全在 `computeDanmakuLayout`（纯函数）：字号按渲染区短边等比缩放，三档封顶——迷你窗 10–14px、非全屏播放窗 12–14px、全屏 12–18px（窗口态面积小，沿用 18px 上限会和全屏一样大、显得拥挤）；摆放取全局偏好 `danmakuPlacement`（`video` 画面内 / `left` 左侧黑边），黑边窄于 220px 时自行回落画面内、入口按钮只在 `canFloatLeft` 时出现；公演（B 站）弹幕另限宽 33vw，防单条横跨整块画面。直播与回放共用，迷你浮窗不传 `placement`。

## 7. 实现约定（易错点）

### 7.1 composable 参数采用 getter 而非值

`useLiveSession({ liveId: () => props.liveId })`。直接传值会在调用瞬间固化，props 的后续变化无法在 composable 内感知。

### 7.2 播放器重建统一由 watch 驱动

`getLiveOne()` 取得地址后本可直接调用 `setupPlayer(地址)`，实现上改为 `watch(localPlaybackUrl, ..., { immediate: true })`：首次播放、断流重试、恢复播放三类场景归并为「写入地址」一个动作，重建逻辑只存在于一处；`immediate: true` 让首挂载也走同一路径。

### 7.3 递增令牌

连续两次点击同一场直播时，第一次请求持有的 `requestId` 会被第二次推进计数，迟到响应检测到自己已过期，主动 `stopLiveStream` 撤销刚登记的会话并放弃写入，不覆盖第二次的结果（分页列表的 `listRequestId` 同模式）。`streamRestartToken` 是另一维度序号，拼进地址的 `?r=` 参数，让同 URL 的两次重启在浏览器/mpegts 眼里是两个不同资源。

### 7.4 详情失败统一走 `onUnavailable`

`getLiveOne` 的 `try/catch` 里，详情接口失败通常意味着直播已下架。错误提示由 `services/apis.ts` 的 `request()` 统一弹窗（3 秒同文案去重），此处不重复弹，只广播 `live-unavailable` 让列表页刷新并 `emit('close')` 关窗；重试耗尽走同一路径。

⚠️ 只有确定性失败才该走这条路：pocketapi 的 `getLiveOne` 会随机返回 `{status:1017}`（同一份 body 约 1/3 命中，与参数、频率、并发无关，2026-09-13 实测），若原样当成下架会无故关播，故 `request()` 对 1017 与网络层异常默认重试 3 次（退避 400/800/1200ms）；`10049 该成员直播已被删除` 等业务结论不重试，立即上抛。在线人数轮询用 `Apis.live(liveId, { silent: true })`。

### 7.5 上游推流中断（连麦等）只能从媒体元素侧感知

主播开始/停止连麦时，官方换发新签名（仅 query 里 `wsSecret` / `wsTime` 变化，Stream Key 不变），旧地址失效 → FFmpeg 退出 → 本地 FLV 响应结束。这条路径**没有任何 mpegts ERROR 事件**，重试状态机不会被触发，恢复入口须自行建立：

- 本地响应没有 `Content-Length`，mpegts 判定为 LOADING_COMPLETE 而非 Early-EOF，不抛 ERROR；随后 `endOfStream()` 把时长校正到最后一段，播完缓冲即触发 `ended`（伴随 `pause`，观感是「停住 + 暂停」）。
- 触发点取媒体元素的 `onended`（直播正常播放时永远不会 ended），一律按网络错误上抛 → `retry.schedule()` → `recoverStream` 重新拉详情拿到**新签名地址**重建。
- ⚠️ 不要改用 mpegts 的 `LOADING_COMPLETE` 兜底：`enableWorker: true` 时 worker 回传的包只有 `{ msg, event }`、不带 `extraData`，主线程按 `'extraData' in packet` 判断后直接丢弃该事件。
- 重试计数语义是「连续失败次数」，必须在 canplay 时清零，否则一场直播里累计断流 3 次（连麦很容易做到）会被误判为「已结束」并关窗。

### 7.6 开播前的 FFmpeg 校验只做一次

`stores/float-players.ts` 的 `openLive` 是四个开播入口（直播列表 / 公演页 / 房间资料卡 / 房间分享卡）的唯一汇聚点，`use-live-guard` 的 `checkLiveReady()` 接在这里，新增入口无需接线；`openPlayback` 不做该校验——回放走 mpegts 直连，不经过 FFmpeg 转封装。判定口径与启动门禁、下载守卫共用 `window.mainAPI.getFfmpegStatus`（`inspectFfmpegDir`），不要另起一套。

## 8. 弹幕链路

与播放链路并行、共享 LivePlayer 的互动消息子系统。**双源按直播类型分流，互不混用**：

| 直播类型                    | 数据源         | 会话锚点                              | 主进程模块                         |
| --------------------------- | -------------- | ------------------------------------- | ---------------------------------- |
| 公演（`source='open'`）     | B 站弹幕       | `bilibiliRoomId`（payload 携带）      | `main/bilibili/danmaku-session.ts` |
| 个人直播（`source='user'`） | 口袋48互动消息 | `chatroomId`（use-live-session 补拉） | `main/pocket48/pocket-danmaku.ts`  |

两源由 `use-live-danmaku` 统一订阅，投放到同一气泡层；口袋的 LIVEUPDATE 消息不进气泡层，路由到左上角互动榜面板。口袋源走自研网易云信 TCP 客户端（`nim-chatroom.ts`），需登录口袋账号；进房身份（SDK 版本与包名）随登录档位取自 `client-profile.ts` 的 `nim` 字段，与 HTTP 请求报同一家客户端，登录态变更时旧会话会被断开。

**B 站房间号三级解析**（`utils/bilibili-room.ts`，从严到宽，全部落空则无弹幕）：① `teamList[0].groupId` 查团体房间表（`common/bilibili-rooms.ts`）；② 标题/副标题文本匹配，先团体名（SNH48…）再队伍名（TEAM X…，接口的 teamName 不含团体名）；③ 在线兜底：主进程拉五个官方直播间信息（`bilibiliRoomInfos` IPC，缓存 5 分钟），只取在播中的房间，与公演名书名号段互配命中——teamList 为空的公演（新生公演、生日会等）靠这层发现。

弹幕连不上只提示一次，不影响直播播放：B 站握手失败经 toast 提示后关闭弹幕层；口袋源断连由协议客户端自动重连，未登录则不建立会话。

## 9. 对照：历史公演（回放）链路

`openHistoryStream` → `openPlayback(payload)` → `PlaybackPlayer`：`usePlaybackEngine` 按后缀选 hls.js 或原生 `<video>` 直接加载（维护 loading / buffering / error 三态），`usePlaybackDanmaku` 按当前播放时间推进弹幕游标。该链路不涉及 FFmpeg 与本地 HTTP 服务，因为 VOD 地址（http 协议的 m3u8/mp4）浏览器可直接播放。

## 10. 链路验证

三条播放链已埋 debug 日志，scope 对照表登记在 `utils/debug.ts` 头部；播放相关的是 `live`（直播链与双源弹幕收发）、`show`（status 分流与 B 站房间映射）、`playback`（回放链），同表另有 `net`（所有链共用的请求层）、`list` / `load-more`（列表分页）、`tasks`（下载录制）、`pocket-auth` / `pocket-rooms` / `rooms-page`（房间链）。渲染层由 `import.meta.env.DEV` 门控，`npm run dev` 即输出（`[DBG]` 前缀，故意不用 `console.debug`——后者默认被 DevTools Verbose 过滤器隐藏）；主进程由 `is.dev || DESKTOP48_VERBOSE=1` 门控；IPC 层由 `handleTraced` 自动记录通道名/参数摘要/耗时/错误。排查时在 `getLiveOne()` 处设断点逐步步进，调用栈面板会完整呈现链路与各变量取值。
