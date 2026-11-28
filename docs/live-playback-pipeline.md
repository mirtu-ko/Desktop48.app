# 播放链路

本文说明直播、录播（回放）与公演播放的核心架构、跨进程边界、状态流转与关键约束。与之并行的房间消息链路见 [room-message-pipeline.md](./room-message-pipeline.md)。

## 1. 架构定位与分层

48 官方直播源为 `rtmp://`，浏览器内核无法直播，需由主进程 spawn FFmpeg 转封装为本地 HTTP-FLV；录播（VOD）为 `http(s)` 的 `.m3u8` / `.mp4`，渲染层直连播放，不经过 FFmpeg。

| 层级       | 模块                                                                 | 职责                                                       |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 入口与汇聚 | `Shows.vue` / `Lives.vue` / `Playbacks.vue` → `stores/float-players` | 载荷归一、开播前唯一 FFmpeg 守卫（`checkLiveReady`）       |
| 播放器编排 | `LivePlayer.vue` / `PlaybackPlayer.vue` 及 `composables/use-live-*`  | 详情拉取、播放器实例、断流重试、结束态复盘、弹幕与快捷键   |
| 预加载桥   | `src/preload/index.ts` / `src/preload/ipc-contract.d.ts`             | 将主进程能力暴露为 `window.mainAPI.*`                      |
| 主进程转流 | `main/stream.ts` / `main/http-server.ts` / `main/stream-idle-guard`  | 会话登记、延迟 spawn FFmpeg、本机回环 HTTP-FLV、空闲守卫   |
| 主进程窗口 | `main/window/float-window.ts` / `common/float-window.ts`             | 独立播放窗去重、载荷回取、自适应尺寸定形与生命周期         |
| 主进程弹幕 | `main/bilibili/danmaku-session.ts` / `main/pocket48/pocket-danmaku`  | 双源长连接会话管理、订阅者生命周期与批量下发               |

主进程边界：`main/stream.ts` 只导出纯业务函数，由 `main/ipc/register-stream-ipc.ts` 经 `handleTraced` 统一接线；任何交给 FFmpeg 的地址都必须先过 `main/net/allowed-hosts.ts` 的 `isAllowedStreamUrl` 白名单。

## 2. 直播播放主链路与转流保障

```
列表页点击 → stores/float-players.openLive (checkLiveReady 校验 FFmpeg)
  ──IPC──▶ [main/window/float-window.ts] 按 kind:liveId 去重，打开独立播放窗 (#/float?kind&liveId)
  ▼
[LivePlayer.vue] floatPlayerGetPayload 回取全量载荷 → use-live-session.getLiveOne()
  ├─ fetchLiveDetail()：open 源 pickPreferredStream(playStreams) / user 源单档 rtmp
  └─ createLiveStream(rtmpUrl, liveId)
       ──IPC──▶ [main/stream.ts] 校验端口与白名单，仅登记 { liveId → rtmpUrl }（同 liveId 换新地址时顺手停掉旧进程）
       ◀── http://127.0.0.1:<port>/live/<id>.flv
  ▼ （写入 localPlaybackUrl，经 buildPlaybackUrl 附 ?t=&r=，watch immediate 驱动挂载）
[use-live-player.ts] mpegts.js GET 本地地址
  ──HTTP──▶ [main/http-server.ts] Origin 校验 → 此刻才 spawn FFmpeg (-c copy -f flv pipe:1) → stdout.pipe(res)
  ▼
mpegts 解析 FLV → MSE → <video> oncanplay → 解除 loading
```

- **延迟启动与首帧发头**：`handleCreateLiveStream` 不启动 FFmpeg，播放器真正发起 HTTP GET 时才 spawn（避免建窗即关留孤儿进程；同地址复用会话）。`http-server.ts` 延迟到收到 `ffmpeg.stdout` 首块流数据时再发 `200 video/x-flv` 头：未出首帧即退出/超时返回 `502`/`504`（读错误返回 `500`），已发 200 后异常退出一律空 `res.end('')`，不向二进制流追加纯文本污染 FLV。
- **Linux FFmpeg 回落**：`resolveFfmpegEnvironment` 按「显式目录 → 系统 `ffmpeg`（`findSystemFfmpeg`）」优先级查找。`ffmpeg-static` 的 Linux 静态链接产物无动态加载器，解析域名会 `EAI_SYSTEM`/SIGSEGV（`-version` 冒烟测不出来），故 deb 包声明 `depends: ffmpeg` 兜底。
- **双向资源回收**：渲染层 `onUnmounted` 销毁播放器并停会话；HTTP `close`/`finish`/`aborted` 直接 `SIGKILL` 对应进程；`handleStopLiveStream` 优雅写 `'q'` → 2s 未退调 `forceKill`（`SIGTERM` 后 1s 超时升级 `SIGKILL`）；主窗口关闭或 `before-quit` 调 `cleanupStreamSessions()` 清空全部会话。
- **两类地址区分**：`LiveDetail.playStreamPath` 是接口契约字段（官方 `rtmp://` 输入），不可更名；`localPlaybackUrl` 是内部状态（本地 `http://127.0.0.1:...` 输出）。

## 3. 独立播放窗与数据形态

| 关注点   | 关键实现与约束                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 窗口与载荷 | `frame:false` + `alwaysOnTop` + `backgroundThrottling:false`（防失焦节流弹幕/轮询）；hash 只带 `kind`+`liveId`，全量载荷由主进程持有以支持 reload 自愈 |
| 尺寸定形 | `computeInitialWindowSize` 按所在显示器 `workArea` 连续插值计算初始尺寸；首次 `@aspect` 无条件定形，落定后才尊重用户缩放（`decideAutoFit`）；电台窗（`liveType === 2`）恒用 9:16 兜底且永不上报 aspect |
| 平台与控制 | 窗口控制一律按 `BrowserWindow.fromWebContents(event.sender)` 定位；Linux 下 `closeAllFloatWindows()` 走 `destroy()` 不触发 `unload`，须在主窗口 `closed` 调 `cleanupStreamSessions()` |
| 详情归一化 | `fetchLiveDetail` 将公演多档 `playStreams` 与个人单档归一为 `LiveDetail`；在线人数首帧来自详情，实时刷新走口袋云信 `LIVEUPDATE`（公演/未登录保持首帧） |

## 4. 播放器编排、故障恢复与结束态

`LivePlayer.vue` 组合 8 个核心 composable（`session` / `retry` / `player` 环状引用靠函数声明提升解耦）：

| composable           | 负责                                                       | 不负责                             |
| -------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `use-live-session`   | 拉详情、补拉聊天室 ID、开/停转流会话、界面状态同步         | 播放器实例、重试节奏、弹幕订阅     |
| `use-live-player`    | mpegts 实例创建/销毁、媒体元素复位                         | 地址来源、错误处理策略             |
| `use-stream-retry`   | 重试节奏（默认 2s × 3，决策走纯函数 `nextRetryAttempt`）   | 具体恢复逻辑（由 `attempt` 注入）  |
| `use-video-rotation` | 旋转 / 容器全屏 / 播放暂停 / 音量                          | 地址、重试                         |
| `use-sleep-blocker`  | 播放期间阻止系统休眠                                       | 播放行为                           |
| `use-media-download` | 录制发起（原始 RTMP 直存，不经本地转封装）                 | 页面播放链路                       |
| `use-live-danmaku`   | 双源弹幕订阅、投放节拍与自发回推认领                       | 播放行为、气泡层渲染               |
| `use-danmaku-layer`  | 弹幕层锚定（画面内 / 左侧黑边）、字号与宽度上限计算        | 弹幕内容与生命周期                 |

### 关键约束与状态流转

- **响应式与复位**：composable 参数统一传 getter（防 props 固化）；播放器重建统一由 `watch(localPlaybackUrl, { immediate: true })` 驱动；`resetMediaElement` 清空 `onerror`/`oncanplay`/`onloadedmetadata`/`onended` 防止旧句柄串场；`requestId` 拦截过期详情回包，`streamRestartToken` 拼入 `?r=` 防止 mpegts 复用缓存。
- **断流与静默故障**：
  - 主播连麦换签名时旧流结束不触发 mpegts `ERROR`（也不能用 `LOADING_COMPLETE`，worker 模式下会被丢弃），统一由媒体元素 `onended` 按网络错上抛进 `retry.schedule()`，并在 `oncanplay` 清零连续失败计数。
  - `main/stream-idle-guard.ts` 监控 `ffmpeg.stdout`，10s 无数据即结束响应（未发头回 `504`，已发头空结束触发 `ended`），把本机断网/推流静默挂死转入既有重试链。
  - 所有失败出口收敛至 `loadFailureKind`（`stream | detail | offline`）与 `markLoadFailed()`，离线直接短路详情与列表请求，`online` 事件自动触发 `retryAfterStall()`；`request()` 对随机 `{status:1017}` 与网络异常默认重试 3 次，业务结论不重试。
- **下播结束态 vs 下架删除**：
  - `enterLiveEnded`（下播结束卡，不关窗）的入口：`CLOSELIVE` 推送、详情/换流（`handleLiveRestream`）判 `review=true` / VOD 地址 /「回放生成中」、重试耗尽后列表复核已无本场（仅 user 源）。进入后停流停计时停弹幕、广播 `live-unavailable` 刷新列表，并拉 `POST live/api/v1/live/result` 展示复盘（必须带登录 token，`liveTime`/`totalMoney`/`liveId` 按字符串宽松解析；拉不到降级简版卡）。
  - `closeUnavailableLive`（详情或换流明确报 `10049 已被删除`）为错误态，停流并立即关窗。
- **交互与空态细节**：
  - 快捷键共用 `useMediaShortcuts`，直播不接 `←/→`，电台模式仅禁用旋转快捷键、保留 `↑/↓` 调音量。
  - 房间消息隐藏时点「发送弹幕」会同步开启消息层并聚焦输入条。
  - 直播列表空态 `use-live-idle` 每 30s 推进 `clock` 刷新「已等待 N 分钟」，并同步 `useLiveStatusStore.lastFetchedAt` 更新「上次检查」时间。

## 5. 弹幕链路

双源按直播类型分流，由 `use-live-danmaku` 统一投放至气泡层，几何布局由纯函数 `computeDanmakuLayout` 负责：

| 直播类型                    | 数据源         | 会话锚点                              | 主进程模块                         |
| --------------------------- | -------------- | ------------------------------------- | ---------------------------------- |
| 公演（`source='open'`）     | B 站只读弹幕   | `bilibiliRoomId`（payload 携带）      | `main/bilibili/danmaku-session.ts` |
| 个人直播（`source='user'`） | 口袋48互动消息 | `chatroomId`（`use-live-session` 补拉） | `main/pocket48/pocket-danmaku.ts`  |

- **主进程会话治理**：两处会话表的 `subscribers` 均为 `Map<WebContents, () => void>`，显式退订或会话销毁时同步摘除 `destroyed` 监听防止累积；`handleDanmakuStart` 与 `handlePocketDanmakuStart` 在异步握手/取凭据后均复核并发入册的会话，防止重复建连与旧连接泄漏；登录态变更时 `resetPocketDanmakuSessions()` 断开全部口袋会话。
- **B 站房间号三级解析**（`utils/bilibili-room.ts`）：`teamList[0].groupId` 查表 → 标题/副标题匹配团体/队伍名 → 在播官方房间书名号兜底（主进程缓存 5 分钟）。
- **口袋消息路由与发送**：`LIVEUPDATE` 驱动在线人数与互动榜；`CLOSELIVE` 进下播结束态；`INFORM_PULL_STREAM` 触发 `handleLiveRestream` 拉详情换流（地址未变跳过，已下播/下架走对应分流）；其余 13 类连麦/PK 指令静默丢弃。发送弹幕仅个人直播可用，复用当前聊天室会话（`sourceId` 必传 `liveId`），发送成功后本地先上屏并在 10s 窗口按 ID 或 `userId+正文` 认领服务端回推。

## 6. 录播（回放）链路与调试

- **回放链路**：`openPlayback(payload)` → `PlaybackPlayer.vue`，直连 VOD 地址不经 FFmpeg。`usePlaybackEngine` 通过 `isHlsSourceUrl`（按 `URL.pathname` 识别，兼容带防盗链 query/hash 的 `.m3u8`）选择 `hls.js` 或原生 `<video>`；`usePlaybackDanmaku` 维护递增请求序号 `loadSeq`，在 `loadBarrages` 与 `resetBarrageSource` 拦截切源/重置后的过期回包。
- **调试日志**：scope 定义见 `utils/debug.ts`（播放相关：`live` / `show` / `playback` / `net` / `list`）。渲染层由 `import.meta.env.DEV` 门控，主进程由 `is.dev || DESKTOP48_VERBOSE=1` 门控，IPC 由 `handleTraced` 自动记录耗时与错误。
