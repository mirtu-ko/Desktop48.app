<script setup lang="ts">
// 统一底部 Dock 导航：后仰的玻璃板 + 站在板上的图标。
// 3D 只做在板这一层（.dock-board），导航项待在平板层里 —— 父级 3D 变换会把子元素压平，
// 子元素的 rotateX 反不过来，所以图标绝不能放进倾斜的坐标系

import type { ComponentPublicInstance, CSSProperties } from 'vue'
import { useEventListener } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

export interface DockItem {
  /** 路由 path（Constants.Menu 值，如 '/lives'），同时作为激活态匹配标识；点击后原样 push */
  index: string
  label: string
  /** Element Plus 图标组件 */
  icon: any
  /** 主题色：悬浮/激活时图标渐变与光晕的颜色，缺省用品牌紫 */
  color?: string
  /** 角标数字：>0 时显示，超过 99 显示 99+ */
  badge?: number
}

const props = defineProps<{
  items: DockItem[]
  active: string
}>()

const emit = defineEmits<{ change: [index: string] }>()

/** 激活指示条尺寸，以及它底边距板下沿的距离（须与 .dock-indicator 的 CSS 一致） */
const INDICATOR_WIDTH = 13
const INDICATOR_HEIGHT = 3
const INDICATOR_BOTTOM = 6
/** 项没给 color 时的兜底主题色 */
const FALLBACK_COLOR = 'var(--brand-primary)'

const dockRef = ref<HTMLElement | null>(null)
/** 首帧定位完成后才放开指示条过渡，否则它会从左上角滑入 */
const ready = ref(false)

/** 各导航项元素，只在脚本内做测量，不参与渲染 */
const itemEls: HTMLElement[] = []
const indicatorStyle = ref<CSSProperties>({ opacity: 0 })
const activeColor = computed(() => props.items.find(item => item.index === props.active)?.color || FALLBACK_COLOR)
/** 上一次写入的阴影色源，避免同色反复写 DOM */
let glowColor = ''

function setItemEl(el: Element | ComponentPublicInstance | null, index: number) {
  if (el instanceof HTMLElement)
    itemEls[index] = el
}

/** 滑动激活指示条：贴住板下沿（y 由 Dock 自身高度算），横坐标取激活项的布局位置 */
function syncIndicator() {
  const dock = dockRef.value
  const el = itemEls[props.items.findIndex(item => item.index === props.active)]
  if (!dock || !el)
    return
  indicatorStyle.value = {
    transform: `translate(${el.offsetLeft + (el.offsetWidth - INDICATOR_WIDTH) / 2}px, ${dock.offsetHeight - INDICATOR_BOTTOM - INDICATOR_HEIGHT}px)`,
    opacity: 1,
  }
}

function onPointerMove(e: PointerEvent) {
  const dock = dockRef.value
  if (!dock)
    return
  dock.style.setProperty('--mx', `${e.clientX - dock.getBoundingClientRect().left}px`)
  dock.style.setProperty('--glow', '1')
  // 阴影 / 氛围光的色源 = 光标正指向的那一项（图标、标签都算在项内）
  const color = (e.target as HTMLElement | null)?.closest<HTMLElement>('.dock-item')?.style.getPropertyValue('--item-color')
  if (color && color !== glowColor) {
    glowColor = color
    dock.style.setProperty('--hover-color', color)
  }
}

/** 移除内联变量即回落到 CSS 默认值，由过渡曲线负责归位 */
function onPointerLeave() {
  const dock = dockRef.value
  dock?.style.setProperty('--glow', '0')
  dock?.style.removeProperty('--hover-color')
  glowColor = ''
}

watch(() => props.active, () => nextTick(syncIndicator))

useEventListener(dockRef, 'pointermove', onPointerMove)
useEventListener(dockRef, 'pointerleave', onPointerLeave)

onMounted(async () => {
  await nextTick()
  syncIndicator()
  // 定位落到 DOM 后下一帧再放开过渡，避免首帧被当作一次位置变化
  requestAnimationFrame(() => {
    ready.value = true
  })
})
</script>

<template>
  <nav
    ref="dockRef"
    class="app-dock"
    :class="{ 'is-ready': ready }"
    :style="{ '--accent-color': activeColor }"
  >
    <!-- 后仰的玻璃板（纯背景层，不接事件）：3D 只在这里，图标不会跟着歪 -->
    <span
      class="dock-board"
      aria-hidden="true"
    >
      <!-- 光标跟随的氛围光层 -->
      <span class="dock-glow" />
    </span>
    <!-- 滑动激活指示条：位置由脚本测量后注入 -->
    <span
      class="dock-indicator"
      :style="indicatorStyle"
      aria-hidden="true"
    />

    <button
      v-for="(item, i) in items"
      :key="item.index"
      :ref="el => setItemEl(el, i)"
      type="button"
      class="dock-item"
      :class="{ 'is-active': active === item.index }"
      :style="{ '--item-color': item.color || FALLBACK_COLOR }"
      :aria-current="active === item.index ? 'page' : undefined"
      @click="emit('change', item.index)"
    >
      <span class="dock-icon">
        <el-icon><component :is="item.icon" /></el-icon>
        <!-- 角标：正在进行的任务数量，最多 2 位 -->
        <span
          v-if="item.badge"
          class="dock-badge"
        >{{ item.badge > 99 ? '99+' : item.badge }}</span>
      </span>
      <span class="dock-label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped lang="scss">
/* 底部 Dock。后仰只做在板这一层：板绕 X 轴转、origin 在底边 → 只有板顶向后倒，
 * 屏幕上是上窄下宽的梯形；图标待在平板层里，天然是正的 */
.app-dock {
  position: fixed;
  left: 50%;
  bottom: 16px;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 30px 10px;
  user-select: none;
  transform: translateX(-50%);

  /* 后仰角，只在 .dock-board 上用 */
  --dock-tilt: 30deg;
  /* 脚本实时写入：--mx 氛围光横坐标 / --glow 显隐 / --hover-color 光标指向项的主题色 */
  --mx: 50%;
  --glow: 0;
  --accent-color: var(--brand-primary);
  /* 阴影与氛围光的色源：光标正指向那一项优先，离开时回退到激活项 */
  --glow-color: var(--hover-color, var(--accent-color));
}

/* ===== 后仰的玻璃板：Dock 的 3D 全部集中在这一层 =====
 * 导航项不能放进这个坐标系：父级 3D 变换下的子元素会被压平，子元素的 rotateX 只剩
 * 「竖向压扁」这一半效果（实测图标 h/w 0.61，比不反向旋转的 0.69 还扁），反不过来 */
.dock-board {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: 18px;
  /* 悬浮时只调这一档投影浓度，省掉整套阴影重写 */
  --glow-alpha: 42%;
  /* perspective 越小透视越强：板顶收得越窄、立体感越猛 */
  transform: perspective(450px) rotateX(var(--dock-tilt));
  /* 锚在底边：板贴住页面底部不动，只有顶边向后倒 */
  transform-origin: center bottom;
  /* 玻璃配方与左右上角的浮层同源（:root 的 --glass-*），差异只有两项：
   * 1) 多叠一层跟随 --glow-color 的氛围投影（板块大、又后仰，需要更散的环境光托住）；
   * 2) 下边换成更亮的前沿亮线 —— 后仰时它就是这块厚玻璃的断面。
   * 注意 box-shadow 是「先写的画在上面」，前沿线必须排在 --glass-lip 之前才压得住里面那条 */
  background: var(--glass-sheen), var(--glass-fill);
  backdrop-filter: var(--glass-blur);
  box-shadow:
    var(--glass-shadow),
    inset 0 -1px 0 rgba(255, 255, 255, 0.85),
    var(--glass-lip),
    0 20px 46px -16px color-mix(in srgb, var(--glow-color) var(--glow-alpha), transparent);
  transition: box-shadow 0.3s ease;
}

.app-dock:hover .dock-board {
  --glow-alpha: 54%;
}

/* ===== 光标跟随氛围光：贴在板底边、随光标横向滑动的主题色光斑 ===== */
.dock-glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: var(--glow);
  background: radial-gradient(
    150px 88px at var(--mx) 116%,
    color-mix(in srgb, var(--glow-color) 40%, transparent),
    transparent 72%
  );
  transition: opacity 0.35s ease;
}

/* ===== 滑动激活指示条：激活态的「锚点」，贴住板下沿，切页时弹到下一项 ===== */
.dock-indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  width: 13px;
  height: 3px;
  border-radius: var(--radius-pill);
  pointer-events: none;
  opacity: 0;
  background: var(--accent-color);
  box-shadow: 0 0 10px 2px color-mix(in srgb, var(--accent-color) 55%, transparent);
  animation: dock-dot-pulse 2.4s ease-in-out infinite;
}

/* 过渡只在首帧定位完成后启用，否则指示条会从左上角飞过来 */
.app-dock.is-ready .dock-indicator {
  transition:
    transform 0.42s cubic-bezier(0.34, 1.4, 0.64, 1),
    background 0.3s ease;
}

.dock-item {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 56px;
  padding: 0 0 4px;
  border: none;
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  animation: dock-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;

  /* 入场依次弹出。装饰层是 span、导航项是 button，用 nth-of-type 才数得对 */
  @for $i from 1 through 8 {
    &:nth-of-type(#{$i}) {
      animation-delay: $i * 0.05s;
    }
  }

  /* 图标块：白色玻璃小磁贴。放大锚在底边 → 悬浮时向上长，不会压到下面的标签 */
  .dock-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 13px;
    transform-origin: center bottom;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.62));
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.95),
      /* 落在板面上的接触阴影：图标要「压」在板上，不能飘着 */ 0 6px 12px -5px rgba(var(--shadow-rgb), 0.42);
    color: var(--el-text-color-regular);
    transition:
      transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
      background 0.25s ease,
      color 0.25s ease,
      box-shadow 0.25s ease;

    .el-icon {
      font-size: 21px;
    }

    /* 角标：磁贴右上角的任务数胶囊，用该项主题色点亮 */
    .dock-badge {
      position: absolute;
      top: -5px;
      right: -7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: var(--radius-pill);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      color: #fff;
      background: linear-gradient(135deg, color-mix(in srgb, var(--item-color) 80%, #000), var(--item-color));
    }
  }

  .dock-label {
    font-size: 11px;
    line-height: 1.2;
    color: var(--el-text-color-secondary);
    transition: color 0.2s ease;
  }

  &:hover {
    .dock-icon {
      transform: scale(1.2);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--item-color) 22%, #fff),
        color-mix(in srgb, var(--item-color) 8%, #fff)
      );
      color: var(--item-color);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.8),
        0 12px 24px -8px color-mix(in srgb, var(--item-color) 60%, transparent);
    }

    .dock-label {
      color: var(--item-color);
    }
  }

  /* 激活图标：主题色渐变磁贴，像点亮的应用图标（写在 hover 之后才压得住） */
  &.is-active {
    .dock-icon {
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--item-color) 78%, #000) 0%,
        var(--item-color) 52%,
        color-mix(in srgb, var(--item-color) 55%, #fff) 100%
      );
      color: #fff;
      /* 激活态没有整项底框，全靠磁贴自身撑住：渐变 + 更实的同色光晕 */
      box-shadow: 0 12px 24px -8px color-mix(in srgb, var(--item-color) 88%, transparent);
    }

    .dock-label {
      color: var(--item-color);
      font-weight: 600;
    }
  }
}

@keyframes dock-pop {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.9);
  }
}

/* 指示条呼吸：只动透明度，位置由 transform 承担，不能被关键帧覆盖 */
@keyframes dock-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* 关闭动效偏好：收掉入场与呼吸动画，悬浮反馈（颜色 / 缩放）保留 */
@media (prefers-reduced-motion: reduce) {
  .dock-item,
  .dock-indicator {
    animation: none;
  }
}
</style>
