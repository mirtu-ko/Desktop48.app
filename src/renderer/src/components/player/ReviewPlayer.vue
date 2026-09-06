<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMediaShortcuts } from '../../composables/media/use-media-shortcuts'
import { useSleepBlocker } from '../../composables/media/use-sleep-blocker'
import { useVideoRotation } from '../../composables/media/use-video-rotation'
import { useReviewDanmaku } from '../../composables/review/use-review-danmaku'
import { useReviewMedia } from '../../composables/review/use-review-media'
import useMediaDownload from '../../composables/tasks/use-media-download'
import Apis from '../../services/apis'
import { debugLog } from '../../utils/debug'

import { BARRAGE_SIDEBAR_WIDTH } from '../../utils/float-player-layout'
import { normalizeCarouselTime, pickPreferredVodStream } from '../../utils/live-stream'
import Tools from '../../utils/tools'
import BarrageBox from '../danmaku/BarrageBox.vue'
import BarrageSidebarToggle from '../danmaku/BarrageSidebarToggle.vue'
import DanmakuSettingsPopover from '../danmaku/DanmakuSettingsPopover.vue'
import MediaIcon from '../ui/MediaIcon.vue'
import MiniControls from './MiniControls.vue'
import PlayerLoading from './PlayerLoading.vue'
import RadioStage from './RadioStage.vue'
import RotationControls from './RotationControls.vue'

const props = defineProps({
  liveTitle: { type: String, required: true },
  liveId: { type: String, required: true },
  startTime: { type: Number, required: true },
  /** 数据源：user=用户直播回放(getLiveOne)，open=开放公演回放(getOpenLiveOne) */
  source: { type: String, default: 'user' },
  /** open 模式下的顶部头像（公演封面，完整 URL） */
  avatarUrl: { type: String, default: '' },
  /** 迷你窗紧凑模式：隐藏弹幕侧栏与对应头部按钮，适配画中画小窗口 */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['avatar', 'aspect', 'sidebar'])

const playStreamPath = ref('')
const isRadio = ref(false)
const number = ref(0)
const nativeVideo = ref<HTMLVideoElement | null>(null)
// 电台模式的 audio 元素由 RadioStage 挂载/卸载时经 @audio 事件回传
const nativeAudio = ref<HTMLAudioElement | null>(null)
const carousels = ref<string[]>([])
const carouselTime = ref(5000)
const realName = ref('')
const userAvatar = ref('')
const sidebarVisible = ref(true)

const videoBoxRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const router = useRouter()

// 录播页只做两类事情：
// 1. 按播放地址选择 HLS 或原生 MP4 播放（use-playback-engine）
// 2. 按录播资源加载弹幕，并在回退/重播时重置弹幕状态
function getActiveMediaElement() {
  return isRadio.value ? nativeAudio.value : nativeVideo.value
}

// =========== 画面旋转 / 容器全屏 / 迷你控制条（与 LivePlayer 共用 useVideoRotation） ===========
// 旋转作用于 video wrapper，弹幕叠加层与之同级、不参与旋转：
// 弹幕的轨道/坐标体系基于容器宽高，保持横向滚动即可，旋转不影响弹幕任何逻辑。
const {
  rotationAngle,
  isVerticalRotation,
  videoWrapperStyle,
  videoStyle,
  rotateHint,
  rotateLeft,
  rotateRight,
  resetRotation,
  onBoxDblClick,
  isFullscreen,
  toggleFullscreen,
  isPip,
  togglePip,
  playing,
  muted,
  togglePlay,
  toggleMute,
  onVolumeChange,
  updateVideoDimensions,
} = useVideoRotation({
  videoBoxRef,
  getMedia: () => (isRadio.value ? nativeAudio.value : nativeVideo.value),
  getVideo: () => nativeVideo.value,
  isRadio,
  onAspect: aspect => emit('aspect', aspect),
})
// =========== 画面旋转结束 ===========

// 侧栏实际占位（有弹幕数据且未收起）上报给浮窗：
// 无弹幕或收起弹幕列表时，放大窗不预留侧栏宽，画面不留空白
const danmaku = useReviewDanmaku({
  videoBoxRef,
  getMedia: getActiveMediaElement,
})
const {
  currentTime,
  barrageUrl,
  hasBarrage,
  barrageEntries,
  barrageListItems,
  barrageLoaded,
  danmakuOverlayItems,
  setDanmakuNode,
  settings,
  seekBarragesTo,
  onTimeUpdate: onDanmakuTimeUpdate,
  ensureBarragesLoaded,
  resetBarrageSource,
  loadSettings,
  toggleDanmaku,
  updateSettings: onDanmakuSettingsUpdate,
  startAnimation: startDanmakuAnimation,
  stopAnimation: stopDanmakuAnimation,
} = danmaku

watch(
  [hasBarrage, sidebarVisible],
  ([has, visible]) => emit('sidebar', has && visible),
  { immediate: true },
)

// 播放防休眠（use-sleep-blocker，与 LivePlayer 共用）
const { acquire: acquireSleepBlocker, release: releaseSleepBlocker } = useSleepBlocker()

// =========== 播放引擎接线（HLS/原生选择与三态在 use-review-media） ===========
const {
  mediaLoading,
  mediaBuffering,
  lastPlaybackError,
  mediaDuration,
  retryPlayback,
  destroy: destroyPlayer,
} = useReviewMedia({
  playStreamPath,
  getMediaElement: getActiveMediaElement,
  getManagedElements: () => [nativeVideo.value, nativeAudio.value],
  onTimeUpdate: onDanmakuTimeUpdate,
  onSeeking: time => seekBarragesTo(time),
  onMetadataLoaded: async () => {
    debugLog('playback', `④元数据就绪: 刷新画面尺寸${isRadio.value ? '（电台无尺寸）' : ''} → 加载弹幕`)
    // 记录源尺寸供旋转缩放计算，并按（可能旋转后的）画面比例上报浮窗
    if (!isRadio.value)
      updateVideoDimensions()
    await ensureBarragesLoaded()
  },
  onPlaying: () => void acquireSleepBlocker(),
  onIdle: releaseSleepBlocker,
})

// =========== 键盘策略（根节点焦点制，见 use-media-shortcuts） ===========
const { onKeydown, onPointerDown } = useMediaShortcuts({
  getRoot: () => rootRef.value,
  getMedia: getActiveMediaElement,
  actions: {
    togglePlay,
    toggleFullscreen,
    toggleDanmaku,
    rotateLeft,
    rotateRight,
    resetRotation,
  },
})

// 迷你条拖进度：录播必须可 seek，弹幕游标由 onseeking 统一同步
function onMiniSeek(value: number) {
  const mediaElement = getActiveMediaElement()
  if (!mediaElement)
    return
  mediaElement.currentTime = value
  currentTime.value = value
}

async function getOne() {
  try {
    if (props.source === 'open') {
      // 开放公演回放：getOpenLiveOne 返回 playStreams 数组（VOD m3u8），优先选超清（streamType 3），
      // 详情里没有用户与在线人数信息，用公演标题与传入的队伍 logo 兜底
      debugLog('playback', `②拉详情: source=open → getOpenLiveOne`, props)
      const data = await Apis.instance().openLive(props.liveId)
      const stream = pickPreferredVodStream(data.playStreams)
      if (!stream?.streamPath) {
        debugLog('playback', `②拉详情: 公演回放选流为空（playStreams=${data.playStreams?.length ?? 0} 条），无法播放`)
        ElMessage({ message: '未获取到公演回放地址', type: 'error' })
        return
      }
      debugLog('playback', `②拉详情: 公演回放选流 → streamType=${stream.streamType}`)
      isRadio.value = false
      number.value = 0
      realName.value = data.subTitle || data.title || '开放公演'
      userAvatar.value = Tools.sourceUrl(props.avatarUrl || '')
      emit('avatar', userAvatar.value)
      barrageUrl.value = data.msgFilePath || ''
      playStreamPath.value = stream.streamPath
      return
    }

    debugLog('playback', `②拉详情: source=user → getLiveOne`, props)
    const data = await Apis.instance().live(props.liveId)

    const nextPlayStreamPath = Tools.streamPathHandle(data.playStreamPath, props.startTime)
    const nextBarrageUrl = data.msgFilePath || ''

    if (!data.review) {
      debugLog('playback', `②拉详情: liveId=${props.liveId} 不是录播（review=false），跳回直播页`)
      ElMessage({
        message: '该视频不是录播',
        type: 'warning',
      })
      router.push('/live')
      return
    }

    isRadio.value = data.liveType === 2
    number.value = data.onlineNum ?? 0
    realName.value = data.user.userName
    userAvatar.value = Tools.sourceUrl(data.user.userAvatar)
    emit('avatar', userAvatar.value)
    carousels.value = isRadio.value && data.carousels?.carousels?.length
      ? data.carousels.carousels.map((carousel: string) => Tools.sourceUrl(carousel))
      : []
    carouselTime.value = isRadio.value
      ? normalizeCarouselTime(data.carousels?.carouselTime)
      : 5000

    const barrageSourceChanged = barrageUrl.value !== nextBarrageUrl
    barrageUrl.value = nextBarrageUrl
    playStreamPath.value = nextPlayStreamPath
    debugLog('playback', `②拉详情: 播放地址与弹幕源已更新（弹幕源${barrageSourceChanged ? '变化 → 重置弹幕状态' : '未变 → 沿用现有弹幕游标'}）`, barrageUrl.value, playStreamPath.value)

    if (barrageSourceChanged)
      resetBarrageSource()
  }
  catch (error: any) {
    console.error(error)
    ElMessage({ message: '获取录播信息失败', type: 'error' })
  }
}

// 点击右侧弹幕即跳转到对应时间点
function seekTo(seconds: number) {
  const mediaElement = getActiveMediaElement()
  if (!mediaElement)
    return
  mediaElement.currentTime = Math.max(0, seconds)
  void mediaElement.play()
}

// 下载发起流程收口在 useMediaDownload（目录校验/文件名/任务下发与直播录制共用）。
// 回放地址用当前已解析的 playStreamPath（VOD 地址稳定，无需重新拉详情）
const { running: downloading, onActionClick: onDownloadClick } = useMediaDownload({
  kind: 'download',
  liveId: () => props.liveId,
  getRealName: () => realName.value,
  startTime: () => props.startTime,
  ext: () => 'mp4',
  getUrl: async () => playStreamPath.value,
})

onMounted(async () => {
  debugLog('playback', `①录播会话开始（liveId=${props.liveId}, source=${props.source}）: 载入弹幕设置 → 启动弹幕动画 → 拉详情`)
  loadSettings()
  startDanmakuAnimation()
  rootRef.value?.focus()

  await getOne()
})

onUnmounted(() => {
  debugLog('playback', `⑤录播会话结束（liveId=${props.liveId}）: 停弹幕动画 → 销毁播放引擎 → 释放防休眠`)
  stopDanmakuAnimation()
  destroyPlayer()
  releaseSleepBlocker()
})
</script>

<template>
  <div
    ref="rootRef"
    class="review-player"
    :style="{ '--barrage-sidebar-width': `${BARRAGE_SIDEBAR_WIDTH}px` }"
    tabindex="-1"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
  >
    <div class="review-content">
      <div class="video-box">
        <div
          ref="videoBoxRef"
          class="video-box-inner"
          :class="{ 'vertical-rotation': !isRadio && isVerticalRotation }"
          @dblclick="onBoxDblClick"
        >
          <RadioStage
            v-if="isRadio"
            :carousels="carousels"
            :interval="carouselTime"
            @audio="nativeAudio = $event"
            @play="playing = true"
            @pause="playing = false"
            @volumechange="onVolumeChange"
          />
          <div v-else class="video-wrapper" :style="videoWrapperStyle">
            <video
              ref="nativeVideo"
              class="video-player"
              :style="videoStyle"
              @play="playing = true"
              @pause="playing = false"
              @volumechange="onVolumeChange"
            />
          </div>

          <div
            v-show="settings.enabled && hasBarrage"
            class="danmaku-container"
            :style="{ opacity: settings.opacity, fontSize: `${settings.fontSize}px` }"
          >
            <div
              v-for="item in danmakuOverlayItems"
              :key="item.id"
              :ref="el => setDanmakuNode(item, el as HTMLElement | null)"
              class="danmaku-item"
            >
              {{ item.content }}
            </div>
          </div>

          <PlayerLoading
            v-if="mediaLoading && !lastPlaybackError"
            label="正在加载录播"
            hint="连接回放源中，请稍候"
          />
          <div v-else-if="mediaBuffering" class="video-mask buffering">
            <span>缓冲中…</span>
          </div>
          <div v-if="lastPlaybackError" class="video-mask error">
            <span>{{ lastPlaybackError }}</span>
            <div class="mask-actions">
              <el-button size="small" type="primary" @click="retryPlayback">
                重试
              </el-button>
              <el-button size="small" type="success" @click="onDownloadClick">
                {{ downloading ? '取消下载' : '去下载' }}
              </el-button>
            </div>
          </div>

          <div class="player-actions">
            <!-- 旋转控制（分段胶囊交互见 RotationControls.vue 头部注释） -->
            <RotationControls
              v-if="!isRadio && !mediaLoading"
              :angle="rotationAngle"
              @rotate-left="rotateLeft"
              @rotate-right="rotateRight"
              @reset="resetRotation"
            />
            <el-tooltip :content="downloading ? '下载中，点击取消' : '下载'" placement="bottom" :show-after="400">
              <button
                class="action-btn action-btn--download"
                :class="{ 'is-active': downloading }"
                :aria-label="downloading ? '取消下载' : '下载'"
                @click="onDownloadClick"
              >
                <MediaIcon name="download" :size="16" />
              </button>
            </el-tooltip>
          </div>

          <!-- 控制条：录播与电台回放都保留拖动进度 seek -->
          <MiniControls
            v-if="!mediaLoading"
            :playing="playing"
            :muted="muted"
            :is-fullscreen="isFullscreen"
            :show-pip="!isRadio"
            :is-pip="isPip"
            :show-progress="true"
            :current-time="currentTime"
            :duration="mediaDuration"
            :compact="compact"
            @toggle-play="togglePlay"
            @toggle-mute="toggleMute"
            @toggle-fullscreen="toggleFullscreen"
            @toggle-pip="togglePip"
            @seek="onMiniSeek"
          />

          <div v-if="rotateHint" class="rotate-hint">
            {{ rotateHint }}
          </div>

          <!-- 视频窗口右边缘：hover 时才浮出的弹幕列表显隐竖条 -->
          <BarrageSidebarToggle
            v-if="!compact && hasBarrage"
            :visible="sidebarVisible"
            @toggle="sidebarVisible = !sidebarVisible"
          />
        </div>
      </div>

      <div v-show="sidebarVisible && !compact && hasBarrage" class="barrage-box">
        <BarrageBox
          :number="number"
          :start-time="startTime"
          :barrage-loaded="barrageLoaded"
          :items="barrageListItems"
          :all-items="barrageEntries"
          @seek="seekTo"
        >
          <template #actions>
            <DanmakuSettingsPopover
              :settings="settings"
              @update="onDanmakuSettingsUpdate"
              @toggle="toggleDanmaku"
            />
          </template>
        </BarrageBox>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.review-player {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  outline: none;
}

/* 悬浮按钮（下载）与右上角容器样式为全局 .player-actions / .action-btn，见 app.scss */

/* 视频占主区域，弹幕列表定宽侧栏；min-height/min-width 为 0 让高度链正确收缩 */
.review-content {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.video-box {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  background: #000;
}

.barrage-box {
  /* 宽度单一来源：utils/float-player-layout.ts 的 BARRAGE_SIDEBAR_WIDTH，
     经根节点 :style 注入的 --barrage-sidebar-width 变量传入（浮窗放大档按此预留侧栏位） */
  width: var(--barrage-sidebar-width);
  flex-shrink: 0;
  min-height: 0;
  background: var(--el-bg-color-page);
}

.video-box-inner {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.danmaku-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: hidden;
  z-index: 10;
  /* 字号由脚本通过内联 style 注入，保证与 measureText 使用同一数值 */
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}

.danmaku-item {
  position: absolute;
  top: 0;
  left: 0;
  white-space: nowrap;
  font: inherit;
  color: #fff;
  text-shadow:
    2px 0 0 #000,
    -2px 0 0 #000,
    0 2px 0 #000,
    0 -2px 0 #000,
    1px 1px 0 #000,
    -1px -1px 0 #000,
    1px -1px 0 #000,
    -1px 1px 0 #000;
  will-change: transform;
  user-select: none;
}

/* video-wrapper / video-player 公共样式见 app.scss */

.video-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #fff;
  font-size: 14px;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.video-mask.error {
  background: rgba(0, 0, 0, 0.72);
  pointer-events: auto;
}

.video-mask.buffering {
  background: transparent;
}

.mask-actions {
  display: flex;
  gap: 8px;
}
</style>
