<script setup lang="ts">
import type { DanmakuOverlayItem } from '@renderer/composables/use-danmaku-overlay'
import type { PropType } from 'vue'
import { debugLog } from '@renderer/utils/debug'
import { ref } from 'vue'

defineProps({
  items: { type: Array as PropType<DanmakuOverlayItem[]>, default: () => [] },
  /** 紧凑模式：气泡内边距与圆角收紧，适配小尺寸独立播放窗 */
  compact: { type: Boolean, default: false },
  /** 「全部弹幕」面板展开时隐藏实时层（保留渲染树，见 .is-hidden 说明） */
  hidden: { type: Boolean, default: false },
})

/**
 * 离场气泡钉位：column-reverse 下脱流的绝对定位子元素会先坠到列表底部再淡出；
 * before-leave 时元素仍在文档流内，写入内联 top/left 才能锚住原位。
 */
function onBeforeLeave(el: Element) {
  const bubble = el as HTMLElement
  bubble.style.top = `${bubble.offsetTop}px`
  bubble.style.left = `${bubble.offsetLeft}px`
}

/** 加载失败的表情图：回退成原始占位符文本（alt 同字，记日志才分得清「没渲染」与「加载失败」） */
const failedEmotes = ref(new Set<string>())

function emoteKey(itemId: number, index: number) {
  return `${itemId}-${index}`
}

function onEmoteError(item: DanmakuOverlayItem, index: number) {
  const segment = item.segments[index]
  failedEmotes.value.add(emoteKey(item.id, index))
  if (segment && segment.type === 'emote')
    debugLog('live', `B站弹幕: 表情图加载失败 ${segment.url}`)
}
</script>

<template>
  <TransitionGroup
    name="danmaku"
    tag="div"
    class="danmaku-bubbles"
    :class="{ 'is-hidden': hidden, 'is-compact': compact }"
    @before-leave="onBeforeLeave"
  >
    <div
      v-for="item in items"
      :key="item.id"
      class="danmaku-bubble"
    >
      <span v-if="item.username" class="danmaku-author">{{ item.username }}</span>
      <span class="danmaku-text">
        <template v-for="(segment, index) in item.segments" :key="index">
          <img
            v-if="segment.type === 'emote' && !failedEmotes.has(emoteKey(item.id, index))"
            class="danmaku-emote"
            :src="segment.url"
            :alt="segment.text"
            referrerpolicy="no-referrer"
            :style="{ aspectRatio: `${segment.width} / ${segment.height}` }"
            draggable="false"
            @error="onEmoteError(item, index)"
          >
          <template v-else>{{ segment.text }}</template>
        </template>
      </span>
    </div>
  </TransitionGroup>
</template>

<style scoped lang="scss">
/* 气泡容器：column-reverse 让最新一条贴底、旧的自上方挤出。
 * height:100% 取自父容器，使容器尺寸与条数解耦；overflow:hidden 把溢出的旧气泡裁在上边界 */
.danmaku-bubbles {
  position: relative;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 0.5em;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 实时层隐藏：不能用 display:none —— 无 box 则 CSS 动画不运行，面板期间新到的弹幕会带着未播放的
 * enter 类挂着、收起时集中补播。visibility:hidden 仍在渲染树中；absolute 是退出 flex 主轴的连带项 */
.danmaku-bubbles.is-hidden {
  position: absolute;
  inset: 0;
  visibility: hidden;
}

/* 弹幕气泡：磨砂玻璃底，不拦截点击（让鼠标穿过看到播放器）；内边距 / 圆角随字号缩放 */
.danmaku-bubble {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  max-width: 100%;
  padding: 0.5em 1em;
  border-radius: 1.33em;
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  backdrop-filter: blur(8px);
  color: rgba(255, 255, 255, 0.94);
  font-size: 1em;
  line-height: 1.35;
  pointer-events: none;
  user-select: none;
}

/* 正文：表情图与文字在同一行流内混排，长文本按词换行 */
.danmaku-text {
  word-break: break-word;
}

/* 表情图：高度跟气泡字号走（紧凑档自动跟着缩）；负垂直对齐量让图底与文字基线齐平。
 * 宽度由内联 aspect-ratio 算出，图片加载前就占好位，避免布局抖动 */
.danmaku-emote {
  height: 1.2em;
  width: auto;
  margin: 0 1px;
  vertical-align: -0.25em;
}

/* 入场：从下方轻浮入位；离场：继续向上飘出 + 淡出；被挤动：平滑上移 */
.danmaku-enter-active {
  animation: danmaku-rise 0.28s ease both;
}

/* 缺此类 Vue 不做 FLIP，余下气泡会瞬移补位 */
.danmaku-move {
  transition: transform 0.3s ease;
}

/* 离场元素脱离文档流，余下气泡立刻补位；位置由 onBeforeLeave 钉死 */
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

/* 迷你窗：气泡更紧凑 */
.danmaku-bubbles.is-compact {
  gap: 0.4em;
}

.danmaku-bubbles.is-compact .danmaku-bubble {
  padding: 0.4em 0.9em;
  border-radius: 1.3em;
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
</style>
