/**
 * 下载 / 录制任务通道组注册。
 *
 * 通用任务机制（并发熔断、文件冲突保护、进程生命周期编排）在 ffmpeg/register-ffmpeg-task.ts，
 * 这里只声明「存在哪两组任务通道」及其 ffmpeg 输出参数差异。
 * 新增任务类型时在此追加一组配置即可，无需改动 ffmpeg/ 内部实现。
 * 通道清单与渲染端 preload/index.ts 的 mainAPI 契约一一对应，两边改动请同步。
 */
import { registerFfmpegTask } from '../ffmpeg/register-ffmpeg-task'

export function registerTaskIPC(): void {
  // 下载任务：HLS TS → MP4
  // -bsf:a aac_adtstoasc: HLS TS 里的 AAC 是 ADTS 格式，MP4 容器需要 ASC 格式，必须转封装
  // -movflags +faststart: 正常结束时把 moov atom 移到文件头，播放器可立即打开
  registerFfmpegTask({
    channelPrefix: 'downloadTask',
    logTag: 'download.ts',
    ffmpegArgs: ['-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart'],
  })

  // 录制任务：RTMP/HTTP 流 → FLV 文件
  // -f flv: 将 RTMP/HTTP 流封装为 FLV 容器
  // 如需断线重连，可追加 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2
  registerFfmpegTask({
    channelPrefix: 'recordTask',
    logTag: 'record.ts',
    ffmpegArgs: ['-f', 'flv'],
  })
}
