<script setup lang="ts">
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import useMediaDownload from '@renderer/composables/use-media-download'
import { useMediaShortcuts } from '@renderer/composables/use-media-shortcuts'
import { usePlaybackDanmaku } from '@renderer/composables/use-playback-danmaku'
import { usePlaybackEngine } from '@renderer/composables/use-playback-engine'
import { useSleepBlocker } from '@renderer/composables/use-sleep-blocker'
import { useVideoRotation } from '@renderer/composables/use-video-rotation'

import Apis from '@renderer/services/apis'
import { debugLog } from '@renderer/utils/debug'
import { normalizeCarouselTime, pickPreferredVodStream } from '@renderer/utils/live-stream'
import { formatMediaTime } from '@renderer/utils/time-format'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
  /** 紧凑模式：缩小弹幕字号与玻璃条尺寸，适配小尺寸独立播放窗 */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['avatar', 'aspect', 'playing'])

const playStreamPath = ref('')
const isRadio = ref(false)
const nativeVideo = ref<HTMLVideoElement | null>(null)
// 电台模式的 audio 元素由 RadioStage 挂载/卸载时经 @audio 事件回传
const nativeAudio = ref<HTMLAudioElement | null>(null)
const carousels = ref<string[]>([])
const carouselTime = ref(5000)
const realName = ref('')
const userAvatar = ref('')
// 观看人数：取自回放详情 onlineNum，供「全部弹幕」面板头部展示（公演回放无此数据）
const onlineNumber = ref(0)

// 弹幕展示模式：实时堆叠 | 全部面板
type DanmakuMode = 'live' | 'all'
const danmakuMode = ref<DanmakuMode>('live')

// 「全部」面板的搜索词：命中全量弹幕（含尚未播放的部分）
const keyword = ref('')
const trimmedKeyword = computed(() => keyword.value.trim().toLowerCase())

const videoBoxRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

// 录播页只做两类事情：
// 1. 按播放地址选择 HLS 或原生 MP4 播放（use-playback-engine）
// 2. 按录播资源加载弹幕，并在回退/重播时重置弹幕状态
function getActiveMediaElement() {
  return isRadio.value ? nativeAudio.value : nativeVideo.value
}

// =========== 画面旋转 / 容器全屏 / 迷你控制条（与 LivePlayer 共用 useVideoRotation） ===========
// 旋转只作用于 video wrapper，弹幕叠加层与之同级不参与旋转；
// 但其锚点取自 videoRect（已含 90/270° 的显示宽高交换），全屏下也贴住画面左下角。
const {
  rotationAngle,
  isVerticalRotation,
  videoRect,
  videoWrapperStyle,
  videoStyle,
  rotateHint,
  rotateLeft,
  rotateRight,
  resetRotation,
  onBoxDblClick,
  isFullscreen,
  toggleFullscreen,
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

// 播放/暂停上报父级：独立播放窗据此决定是否置顶（播放中才置顶）。
// 只上报「变化」而不带上初值：窗口刚打开时还在加载，此刻保持创建时的置顶态，
// 免得视频还没出画面就先掉到别的窗口后面。
watch(playing, value => emit('playing', value))

// 弹幕以「左下角玻璃条」呈现
const danmaku = usePlaybackDanmaku({
  getMedia: getActiveMediaElement,
})
const {
  currentTime,
  barrageUrl,
  hasBarrage,
  barrageLoaded,
  barrageEntries,
  danmakuOverlayItems,
  seekBarragesTo,
  onTimeUpdate: onDanmakuTimeUpdate,
  ensureBarragesLoaded,
  resetBarrageSource,
} = danmaku

// 「全部」面板条目：无关键词直接引用全量数组，否则按内容 / 用户名过滤（忽略大小写）
const displayEntries = computed(() => {
  const kw = trimmedKeyword.value
  if (!kw)
    return barrageEntries.value
  return barrageEntries.value.filter(item =>
    item.content.toLowerCase().includes(kw)
    || item.username.toLowerCase().includes(kw),
  )
})

// 开播时间，与观看人数同处面板头部 meta 行
const startDate = computed(() => dayjs(props.startTime).format('YYYY-MM-DD HH:mm'))

// 切换弹幕展示模式：实时 ⇄ 全部
function toggleDanmakuMode() {
  if (!hasBarrage.value)
    return
  danmakuMode.value = danmakuMode.value === 'live' ? 'all' : 'live'
}

// 弹幕字号按窗口大小自适应：迷你浮窗 10px，普通浮窗/主画面 12px，全屏 14px
const danmakuFontSize = computed(() => {
  if (isFullscreen.value)
    return 14
  if (props.compact)
    return 10
  return 12
})

// 弹幕条定位：锚视频实际渲染区（去 letterbox 黑边）左下角而非容器左下角 ——
// 全屏下竖屏视频左右是黑边，锚容器会离画面太远。bottom 不低于 46px 以避开底部控制条
const danmakuPosition = computed(() => {
  const rect = videoRect.value
  const margin = 12
  const minBottom = 46
  if (!rect)
    return { left: `${margin}px`, bottom: `${minBottom}px` }
  // 黑边内再内缩一点，让气泡贴近视频画面左下角
  return {
    left: `${(rect.left + margin).toFixed(1)}px`,
    bottom: `${Math.max(minBottom, rect.bottom + margin).toFixed(1)}px`,
  }
})

// 播放防休眠（use-sleep-blocker，与 LivePlayer 共用）
const { acquire: acquireSleepBlocker, release: releaseSleepBlocker } = useSleepBlocker()

// =========== 播放引擎接线（HLS/原生选择、三态与播放源 watch 在 use-playback-engine） ===========
const {
  loading: mediaLoading,
  buffering: mediaBuffering,
  error: lastPlaybackError,
  mediaDuration,
  retryPlayback,
  destroy: destroyPlayer,
} = usePlaybackEngine({
  sourcePath: playStreamPath,
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
    rotateLeft,
    rotateRight,
    resetRotation,
  },
})

// 迷你条拖进度 / 「全部」面板点击跳转共用此 seek 通道：
// 立即回写 currentTime 让进度条跟手，弹幕游标仍由引擎的 seeking 事件统一重置
function onMiniSeek(value: number) {
  const mediaElement = getActiveMediaElement()
  if (!mediaElement)
    return
  mediaElement.currentTime = value
  currentTime.value = value
}

/**
 * 离场气泡钉位：`.danmaku-list__bubbles` 是 column-reverse 容器，主轴起点在底部，
 * 绝对定位子元素（leave-active）不写 top/left 会按「唯一 flex 子项」求解静态位置，
 * 于是脱流瞬间先坠到列表底部再淡出。before-leave 时元素仍在文档流内，写入内联 top/left 即可锚在原位。
 */
function onDanmakuBeforeLeave(el: Element) {
  const bubble = el as HTMLElement
  bubble.style.top = `${bubble.offsetTop}px`
  bubble.style.left = `${bubble.offsetLeft}px`
}

/**
 * 获取回放详情
 * 返回回放详情数据，data.review 为 true 时有回放
 */
async function getLiveOne() {
  try {
    if (props.source === 'open') {
      // 开放公演回放：getOpenLiveOne 返回 playStreams 数组（VOD m3u8），优先选超清（streamType 3），
      // 详情里没有用户与在线人数信息，用公演标题与传入的队伍 logo 兜底
      debugLog('playback', `②拉详情: source=open → getOpenLiveOne, props:`, props)
      const data = await Apis.openLive(props.liveId)
      debugLog('playback', `②拉详情: 公演回放详情 → data`, data)
      const stream = pickPreferredVodStream(data.playStreams)
      if (!stream?.streamPath) {
        debugLog('playback', `②拉详情: 公演回放选流为空（playStreams=${data.playStreams?.length ?? 0} 条），无法播放`)
        ElMessage({ message: '未获取到公演回放地址', type: 'error' })
        return
      }
      debugLog('playback', `②拉详情: 公演回放选流 → streamType=${stream.streamType}`, stream)
      isRadio.value = false
      // 公演回放详情不含在线人数，面板头部固定显示 0
      onlineNumber.value = 0
      realName.value = data.subTitle || data.title || '开放公演'
      userAvatar.value = Tools.sourceUrl(props.avatarUrl || '')
      emit('avatar', userAvatar.value)
      barrageUrl.value = data.msgFilePath || ''
      playStreamPath.value = stream.streamPath
      return
    }

    debugLog('playback', `②拉详情: source=user → getLiveOne, props:`, props)
    const data = await Apis.live(props.liveId)
    debugLog('playback', `②拉详情: 录播详情 → data`, data)

    const nextPlayStreamPath = Tools.streamPathHandle(data.playStreamPath, props.startTime)
    const nextBarrageUrl = data.msgFilePath || ''

    if (!data.review) {
      debugLog('playback', `②拉详情: liveId=${props.liveId} 暂无回放（review=false）`)
      ElMessage({
        message: '录播回放尚未生成！',
        type: 'warning',
      })
      return
    }

    isRadio.value = data.liveType === 2
    onlineNumber.value = data.onlineNum ?? 0
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

    if (barrageSourceChanged) {
      debugLog('playback', `②拉详情: 播放地址与弹幕源已更新（弹幕源变化 → 重新加载）`)
      resetBarrageSource()
    }
  }
  catch (error: any) {
    console.error('PlaybackPlayer.vue, 获取录播信息失败:', error.message)
    ElMessage({ message: '获取录播信息失败', type: 'error' })
  }
}

// 下载发起流程由 useMediaDownload 统一处理（目录校验 / 文件名 / 任务下发与直播录制共用）。
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
  debugLog('playback', `①录播会话开始（liveId=${props.liveId}, source=${props.source}）: 拉详情`)
  rootRef.value?.focus()

  await getLiveOne()
})

onUnmounted(() => {
  debugLog('playback', `⑤录播会话结束（liveId=${props.liveId}）: 销毁播放引擎 → 释放防休眠`)
  destroyPlayer()
  releaseSleepBlocker()
})
</script>

<template>
  <div
    ref="rootRef"
    class="playback-player"
    tabindex="-1"
    @keydown="onKeydown"
    @pointerdown="onPointerDown"
  >
    <div class="playback-content">
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
            v-show="hasBarrage"
            class="danmaku-list"
            :class="{ 'is-compact': compact }"
            :style="{ fontSize: `${danmakuFontSize}px`, ...danmakuPosition }"
          >
            <!-- 实时层必须常驻：v-if 会重建 TransitionGroup 导致整摞堆叠重播入场动画，
                 v-show 的 display:none 又会让 CSS 动画停摆（详见 .is-hidden 处的说明） -->
            <TransitionGroup
              name="danmaku"
              tag="div"
              class="danmaku-list__bubbles"
              :class="{ 'is-hidden': danmakuMode !== 'live' }"
              @before-leave="onDanmakuBeforeLeave"
            >
              <div
                v-for="item in danmakuOverlayItems"
                :key="item.id"
                class="danmaku-bubble"
              >
                <template v-if="item.username">
                  <span class="danmaku-author">{{ item.username }}</span>
                  <span class="danmaku-text">{{ item.content }}</span>
                </template>
                <span v-else class="danmaku-text">{{ item.content }}</span>
              </div>
            </TransitionGroup>
            <!-- 全部模式：外壳常驻（同上），内部行用 v-if 懒渲染，避免上千行长期挂在 DOM 上 -->
            <div
              v-show="danmakuMode === 'all'"
              class="danmaku-all"
            >
              <template v-if="danmakuMode === 'all'">
                <div class="danmaku-all__head">
                  <div class="danmaku-all__title">
                    <span>全部弹幕</span>
                    <span class="danmaku-all__count">{{ displayEntries.length }} 条</span>
                  </div>
                  <div class="danmaku-all__meta">
                    观看人数：{{ onlineNumber }} · {{ startDate }}
                  </div>
                  <label class="danmaku-all__search">
                    <MediaIcon name="search" :size="13" />
                    <input
                      v-model="keyword"
                      type="text"
                      placeholder="搜索内容或用户名，点击结果可跳转"
                    >
                  </label>
                </div>
                <div class="danmaku-all__body">
                  <div
                    v-for="(item, index) in displayEntries"
                    :key="index"
                    class="danmaku-all__row"
                    @click="onMiniSeek(item.seconds)"
                  >
                    <template v-if="item.username">
                      <span class="danmaku-author">{{ item.username }}</span>
                      <span class="danmaku-text">{{ item.content }}</span>
                    </template>
                    <span v-else class="danmaku-text">{{ item.content }}</span>
                    <span class="danmaku-all__time">{{ formatMediaTime(item.seconds) }}</span>
                  </div>
                  <div v-if="!barrageLoaded" class="danmaku-all__hint">
                    弹幕加载中…
                  </div>
                  <div v-else-if="displayEntries.length === 0" class="danmaku-all__hint">
                    {{ trimmedKeyword ? '没有匹配的弹幕' : '暂无弹幕' }}
                  </div>
                </div>
              </template>
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
            :show-progress="true"
            :current-time="currentTime"
            :duration="mediaDuration"
            :compact="compact"
            @toggle-play="togglePlay"
            @toggle-mute="toggleMute"
            @toggle-fullscreen="toggleFullscreen"
            @seek="onMiniSeek"
          >
            <!-- 弹幕模式切换（实时 ⇄ 全部）：最左端，有弹幕时显示 -->
            <template v-if="hasBarrage" #leading>
              <button
                class="mini-btn player-capsule__btn danmaku-mode-btn"
                :class="{ 'is-active': danmakuMode === 'all' }"
                :title="danmakuMode === 'live' ? '切换为全部弹幕' : '切换为实时弹幕'"
                :aria-label="danmakuMode === 'live' ? '切换为全部弹幕' : '切换为实时弹幕'"
                @click="toggleDanmakuMode"
              >
                <MediaIcon name="chat" :size="16" />
              </button>
            </template>
          </MiniControls>

          <div v-if="rotateHint" class="rotate-hint">
            {{ rotateHint }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.playback-player {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  outline: none;
}

/* 悬浮按钮（下载）与右上角容器样式为全局 .player-actions / .action-btn，见 app.scss */

/* 画面占满主区域，弹幕以绝对定位浮在画面左下角；min-height/min-width 为 0 让高度链正确收缩 */
.playback-content {
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

.video-box-inner {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* ===== 左下角玻璃条（抖音式弹幕）：最新一条在最下方，旧的上移淡出 =====
 * left / bottom 由脚本 danmakuPosition 注入；top 与 bottom 双约束把盒子拉伸为确定高度，
 * 面板的 max-height:100% 才有参照（迷你浮窗下绝对值会顶出容器被裁）。
 * width 须在此定死：百分比落在 shrink-to-fit 的绝对定位父上会解析成 auto，面板宽度随内容抖动 */
.danmaku-list {
  position: absolute;
  top: 12px;
  z-index: 10;
  /* 盒子被拉伸到整个可用高度，必须显式声明，否则挡住视频的双击全屏 */
  pointer-events: none;
  width: min(90%, 440px);
  margin-bottom: 6px;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
}

/* 气泡容器：column-reverse 让最新一条贴底、旧的自上方挤出。
 * height:100% 取自父容器而非内容，使容器尺寸与弹幕条数解耦，离场气泡脱流不触发重排；
 * overflow:hidden 把溢出的旧气泡裁在弹幕区上边界 */
.danmaku-list__bubbles {
  position: relative;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 实时层隐藏：不能用 display:none —— 无 box 则 CSS 动画不运行，面板期间新到的弹幕会带着
 * 未播放的 enter 类一直挂着，收起时集中补播一次。visibility:hidden 仍在渲染树中，动画照常计时收敛。
 * absolute 是连带项：退出 .danmaku-list 的 flex 主轴，避免与面板同时占位互相挤压 */
.danmaku-list__bubbles.is-hidden {
  position: absolute;
  inset: 0;
  visibility: hidden;
}

/* 弹幕气泡：磨砂玻璃底，不拦截点击（让鼠标穿过看到播放器） */
.danmaku-bubble {
  display: flex;
  align-items: baseline;
  gap: 6px;
  max-width: 100%;
  padding: 6px 12px;
  border-radius: 16px;
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.94);
  font-size: 1em;
  line-height: 1.35;
  pointer-events: none;
  user-select: none;
}

/* 入场：从下方轻浮入位；离场：继续向上飘出 + 淡出；被挤动：平滑上移 */
.danmaku-enter-active {
  animation: danmaku-rise 0.28s ease both;
}

/* 缺此类 Vue 不做 FLIP，余下气泡会瞬移补位 */
.danmaku-move {
  transition: transform 0.3s ease;
}

/* 离场元素脱离文档流，余下气泡立刻补位（否则先占位 0.3s 再突然消失）。
 * 不写 top/left：column-reverse 下 static position 落在容器底部，位置由 onDanmakuBeforeLeave 钉死 */
.danmaku-leave-active {
  position: absolute;
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

/* 旧气泡自最上方被挤出，继续上飘才与列表方向一致 */
.danmaku-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 作者名 / 正文：气泡与「全部」面板共用同一套行内排版 */
.danmaku-author {
  flex-shrink: 0;
  max-width: calc(100% - 96px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--brand-secondary);
  font-weight: 600;
}

/* 正文可压缩可换行：名字拿不下的宽度由正文让出，长弹幕靠换行而非截断姓名收场 */
.danmaku-text {
  min-width: 0;
  overflow-wrap: break-word;
}

/* 全部弹幕模式激活态：仅换图标颜色，hover 白纱由全局 .player-capsule__btn:hover 统一提供 */
.mini-btn {
  /* 尺寸必须在此声明：插槽内容属于父组件作用域，拿不到 MiniControls 内部的 scoped 规则 */
  width: 28px;
  height: 28px;
}

.danmaku-mode-btn.is-active {
  color: var(--brand-secondary);
}

/* ===== 全部弹幕大玻璃面板：内部滚动 =====
 * 高度上限交给父容器（.danmaku-list 因双约束有确定高度），不用 min(60vh,480px) 这类绝对值 */
.danmaku-all {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  max-height: 90%;
  border-radius: 14px;
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  backdrop-filter: blur(10px);
  overflow: hidden;
  /* 弹幕区整体 pointer-events:none，面板单独恢复交互 */
  pointer-events: auto;
}

.danmaku-all__head {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.92);
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.danmaku-all__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.danmaku-all__count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}

/* 搜索框用原生 input：深色玻璃面板里 Element Plus 的浅色皮肤会跳色 */
.danmaku-all__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.92);
  font-family: inherit;
  font-size: 12px;
}

.danmaku-all__search input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.danmaku-all__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}

/* 整行可点：点击跳转到该条弹幕出现的时刻 */
.danmaku-all__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 14px;
  font-size: 1em;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
}

.danmaku-all__row:hover {
  background: rgba(255, 255, 255, 0.06);
}

/* 面板行宽固定且宽裕，名字可用额度比实时气泡更大（仍留出正文最小可读宽度） */
.danmaku-all__row .danmaku-author {
  max-width: calc(100% - 140px);
}

/* 发送时间：margin-left:auto 收在行尾，flex-shrink:0 防止被压缩；等宽数字让右边界不抖动 */
.danmaku-all__time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.5);
}

.danmaku-all__hint {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

/* 新弹幕入场：从下方轻浮入位 */
@keyframes danmaku-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 迷你窗：玻璃条更瘦，最多占八成宽 */
.danmaku-list.is-compact {
  width: min(80%, 440px);
}

.danmaku-list.is-compact .danmaku-list__bubbles {
  gap: 4px;
}

.danmaku-list.is-compact .danmaku-bubble {
  padding: 4px 9px;
  border-radius: 13px;
}

/* 迷你窗视频区只有百余像素，面板要收住就得压缩头部：meta 行让位给搜索框与列表 */
.danmaku-list.is-compact .danmaku-all__head {
  gap: 4px;
  padding: 7px 9px;
  font-size: 12px;
}

.danmaku-list.is-compact .danmaku-all__meta {
  display: none;
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
