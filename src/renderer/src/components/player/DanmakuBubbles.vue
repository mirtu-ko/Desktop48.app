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
  /** 左侧黑边模式：黑底上无画面要隔离，去掉卡片底色与描边，只留文字 */
  plain: { type: Boolean, default: false },
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
    :class="{ 'is-hidden': hidden, 'is-compact': compact, 'is-plain': plain }"
    @before-leave="onBeforeLeave"
  >
    <div
      v-for="item in items"
      :key="item.id"
      class="danmaku-bubble"
    >
      <span v-if="item.level" class="danmaku-level">Lv{{ item.level }}</span>
      <span
        v-if="item.username"
        class="danmaku-author"
        :class="item.tone ? `danmaku-author--${item.tone}` : undefined"
      >{{ item.username }}</span>
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
  gap: 0.2em;
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

/* 弹幕气泡：实色深底，不拦截点击（让鼠标穿过看到播放器）。
   垂直内边距写死 3px：全屏字号涨到 20px 时框不跟着变胖；水平仍随字号收放。
   无 backdrop-filter：气泡悬在视频上，每窗多条气泡的逐块模糊是线性叠加的每帧成本 */
.danmaku-bubble {
  display: flex;
  /* 顶对齐：名字/正文行框等高（1em×1.35），顶对齐即基线重合，正文换成两行时徽章和名字也不动。
   * baseline 会把徽章的 padding 全坠到基线下方（视觉低 ~2px），
   * center 在正文换行后以整条气泡为基准，徽章和名字会坠到中缝 */
  align-items: flex-start;
  gap: 0.4em;
  max-width: 100%;
  padding: 4px 0.6em;
  border-radius: 1.33em;
  background: var(--player-glass-bg);
  box-shadow: inset 0 0 0 1px var(--player-glass-ring);
  color: rgba(255, 255, 255, 0.86);
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

/* 左侧黑边模式：卡片的底色/描边本来是为了把文字从画面上分离出来，纯黑底上没有可分离的对象，
 * 留着只剩一圈灰框抢注意力。横向内边距归零，让整列从黑边的留白处起排 */
.danmaku-bubbles.is-plain .danmaku-bubble {
  padding-right: 0;
  padding-left: 0;
  background: transparent;
  box-shadow: none;
}

/* 迷你窗：气泡更紧凑 */
.danmaku-bubbles.is-compact {
  gap: 0.4em;
  padding: 3px 0.6em;
}

/* 作者名色调按消息类型区分（布局走全局 .danmaku-author）：
 * 礼物 → 金色；系统（进场/兜底）→ 弱化灰；弹幕缺省走全局的品牌色 */
.danmaku-author--gift {
  color: #ffd479;
}

.danmaku-author--system {
  color: var(--brand-primary-light);
}

/* 等级徽章：作者名旁的小号圆角片；字号略小于正文，避免抢戏。
 * 对齐靠外层 flex-start 顶对齐（理由见 .danmaku-bubble）；顶对齐后胶囊中心仍比名字墨迹
 * 中心高 ~1px——PingFang 类字体墨迹偏上（实测墨迹中心在基线上 0.36em，顶对齐胶囊中心
 * 在 0.43em），下移 0.09em 让胶囊对准墨迹中心 */
.danmaku-level {
  position: relative;
  top: 0.09em;
  flex: none;
  padding: 0.05em 0.5em;
  border-radius: 0.8em;
  background: rgba(255, 212, 121, 0.16);
  box-shadow: inset 0 0 0 1px rgba(255, 212, 121, 0.4);
  color: #ffd479;
  font-size: 0.78em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}

.danmaku-bubbles.is-compact .danmaku-bubble {
  padding: 0.4em 0.6em;
  border-radius: 1em;
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
