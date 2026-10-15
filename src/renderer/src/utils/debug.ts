/**
 * 渲染层日志入口（与主进程 src/main/logger.ts 对称，核心 emit 在 src/common/log.ts；不落盘）。
 *
 * - verbose 门控在模块加载时注入：import.meta.env.DEV 是构建期常量，生产包恒为 false，
 *   debugLog 退化为一次布尔判断的 no-op
 * - 埋点位置约定：只记「决策点与状态流转」（谁发起了什么、走了哪个分支、耗时多久），
 *   不记高频心跳（如任务 progress，逐帧输出会淹没真正有用的片段）
 *
 * ── scope 对照表（新人读代码目录）───────────────────────────────
 * | scope      | 链路               | 关键模块                                          |
 * |------------|--------------------|---------------------------------------------------|
 * | live       | 直播/公演播放链    | LivePlayer → use-live-session → use-live-player   |
 * |            |                    | （主进程侧：stream.ts → http-server → ffmpeg）    |
 * | show       | 公演选路入口       | Shows.vue → 按状态分流到直播链或录播链            |
 * | playback   | 录播 VOD 播放链    | PlaybackPlayer → use-playback-engine (hls.js)       |
 * | tasks      | 下载/录制任务链    | stores/tasks → task-runtime → ffmpeg 任务通道      |
 * | load-more  | 列表分页与自动补拉 | use-load-more → use-paged-live-list               |
 * | list       | 列表数据旅程       | use-paged-list（拉取→过滤→补全→去重）→ Lives.vue |
 * |            |                    | （③收下架广播，与 live 链的首尾呼应）           |
 * | net        | 所有链路共用的网络 | apis.ts → request.ts → 主进程 netRequest          |
 * | pocket-rooms | 房间消息链（编排） | use-pocket-rooms → 频道解析/消息拉取/轮询/翻历史  |
 * | rooms-page | 房间页（展示）     | Rooms.vue → 列表加载/选中/滚底/媒体加载          |
 * ────────────────────────────────────────────────────────────────
 * 直播链跨进程时序：渲染层先 createLiveStream（只登记会话），
 * 播放器 GET 本地地址后主进程 http-server 才 spawn FFmpeg —— 对照终端的 [ipc]/[http-server.ts] 输出。
 * 房间消息链主进程侧对照 [pocket-auth] / [pocket-unread] 输出（均为 debug 级，生产包默认关闭）。
 */

import { setVerboseEnabled } from '../../../common/log'

setVerboseEnabled(import.meta.env.DEV)

export { debugLog } from '../../../common/log'
