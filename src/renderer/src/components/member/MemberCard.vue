<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { Hide, Star, StarFilled, User, View } from '@element-plus/icons-vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { segments } from '@renderer/utils/text-highlight'
import Tools from '@renderer/utils/tools'
import { computed } from 'vue'

/**
 * 成员卡片：成员库网格里的单个成员。
 *
 * 从 Members.vue 抽出来的原因不是「页面太长」，而是这张卡是页面里唯一
 * 自成一体的单元 —— 它需要 6 个入参、3 个事件，内部有一整套头像光环 /
 * 皇冠徽章 / 快捷操作 / 搜索高亮的样式，和分区分组逻辑没有半点关系。
 *
 * 注意 compact 由 prop 传入、而不是让父级用 `.member-list.is-compact .avatar-wrap`
 * 这种后代选择器穿透进来：scoped CSS 的作用域属性只打在组件根节点上，
 * 父级的选择器匹配不到子组件内部的元素，那种写法在拆分后会静默失效。
 */
const props = defineProps<{
  member: MemberDetail
  /** 网格内序号：驱动入场错峰（--i），封顶 16 */
  index: number
  /** 紧凑档：头像与文案同步收小（网格列宽由父级决定） */
  compact?: boolean
  /** 搜索关键词原文（组件内自行归一化）；用于姓名 / 昵称的命中高亮 */
  keyword?: string
  blocked?: boolean
  followed?: boolean
}>()

const emit = defineEmits<{
  select: [member: MemberDetail]
  toggleFollow: [member: MemberDetail]
  toggleBlock: [member: MemberDetail]
}>()

/** 官网独有的补充成员没有口袋 userId：屏蔽与关注都不可用，快捷操作整块不渲染 */
const actionable = computed(() => typeof props.member.userId === 'number')

/** 卡片内联变量：--avatar-accent 供头像光环 / 皇冠取色，--i 是入场错峰的序号 */
const cardStyle = computed(() => {
  const style: Record<string, string | number> = { '--i': Math.min(props.index, 16) }
  const color = Tools.toHex(props.member.ringColor || props.member.teamColor)
  if (color)
    style['--avatar-accent'] = color
  return style
})

/** 卡片第二行：昵称 + 期数（都为空的成员不渲染这一行） */
const sub = computed(() =>
  [props.member.nickname, props.member.periodName].filter(Boolean).join(' · '),
)

/** 总选前三名：皇冠走鎏金呼吸光，其余成员保持队色 */
const topRank = computed(() => {
  const rank = Number(props.member.ranking) || 0
  return rank > 0 && rank <= 3
})

/**
 * 皇冠边长：紧凑档同步收小（头像缩到 60px 后，30px 的皇冠会占到一半，比例失衡）。
 * 只能用 prop 传，不能在 CSS 里写 `.is-compact .media-icon { width: 22px }` ——
 * MediaIcon 的 size 落在内联 style 上，特异性高于任何选择器，那种写法是死规则。
 */
const crownSize = computed(() => (props.compact ? 22 : 30))

const nameSegments = computed(() => segments(props.member.realName, props.keyword || ''))
const subSegments = computed(() => segments(sub.value, props.keyword || ''))
</script>

<template>
  <div
    class="member-card"
    :class="{
      'is-blocked': blocked,
      'is-followed': followed,
      'is-top-rank': topRank,
      'is-compact': compact,
    }"
    :style="cardStyle"
    @click="emit('select', member)"
  >
    <div class="avatar-slot">
      <div class="avatar-wrap">
        <!-- 悬浮流光环：常驻的静态队色环由 .avatar-wrap::before 画，这层只在悬浮时淡入并旋转 -->
        <span class="avatar-flow" />
        <el-image class="avatar" :src="member.avatar" fit="cover" lazy>
          <template #placeholder>
            <div class="media-ph" />
          </template>
          <template #error>
            <div class="media-ph">
              <el-icon :size="30">
                <User />
              </el-icon>
            </div>
          </template>
        </el-image>

        <!-- 排名徽章：总选排名非 0 的成员在头像左上角显示皇冠，数字内嵌皇冠中 -->
        <span v-if="member.ranking" class="rank-crown">
          <MediaIcon name="crownFilled" :size="crownSize" />
          <span class="rank-crown__num">{{ member.ranking }}</span>
        </span>
      </div>

      <!-- 关注 / 屏蔽：一对按钮，始终同处头像下沿，悬浮时自下浮出，不挡脸也不挤动名字。
           「已关注」的状态不在这里表达 —— 它由头像外圈的金色虚线环常驻承担（见样式里
           的 .is-followed），所以按钮不需要常驻，也不会出现「一个孤零零的实心圆钮
           挂在头像下巴上」。 -->
      <div v-if="actionable" class="quick-actions">
        <button
          class="quick-btn quick-btn--follow"
          :class="{ 'is-on': followed }"
          :title="followed ? '取消关注' : '关注 TA，直播列表优先展示'"
          type="button"
          @click.stop="emit('toggleFollow', member)"
        >
          <el-icon :size="13">
            <StarFilled v-if="followed" />
            <Star v-else />
          </el-icon>
        </button>
        <button
          class="quick-btn quick-btn--block"
          :class="{ 'is-on': blocked }"
          :title="blocked ? '解除屏蔽' : '屏蔽 TA 的直播与回放'"
          type="button"
          @click.stop="emit('toggleBlock', member)"
        >
          <el-icon :size="13">
            <Hide v-if="blocked" />
            <View v-else />
          </el-icon>
        </button>
      </div>
    </div>

    <div class="member-meta">
      <p class="member-name ellipsis" :title="member.realName">
        <span
          v-for="(seg, segIndex) in nameSegments"
          :key="segIndex"
          :class="{ 'is-hit': seg.hit }"
        >{{ seg.text }}</span>
      </p>
      <p
        v-if="sub"
        class="member-sub ellipsis"
        :title="sub"
      >
        <span
          v-for="(seg, segIndex) in subSegments"
          :key="segIndex"
          :class="{ 'is-hit': seg.hit }"
        >{{ seg.text }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.member-card {
  /* 无实底卡片皮肤：透明底，悬浮时才浮出「队色柔光卡」；可点击 */
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.22s ease,
    border-color 0.22s ease,
    box-shadow 0.22s ease,
    transform 0.22s ease;

  &:hover {
    transform: translateY(-3px);
    border-color: color-mix(in srgb, var(--avatar-accent, var(--brand-primary)) 45%, transparent);
    background: var(--el-bg-color);
    box-shadow:
      0 6px 16px -6px color-mix(in srgb, var(--avatar-accent, var(--brand-primary)) 45%, transparent),
      var(--shadow-sm);
  }
}

/* 头像槽：缩放只作用在内层 .avatar-wrap，快捷操作挂在这一层，不跟着一起放大 */
.avatar-slot {
  position: relative;
  flex: none;
}

/* 头像圆形容器：渐变光环 + 顶部高光 */
.avatar-wrap {
  position: relative;
  width: 92px;
  aspect-ratio: 1;
  border-radius: 50%;
  padding: 3px;
  background: radial-gradient(circle at 30% 20%, #fff, rgba(255, 255, 255, 0));
  transition: transform 0.25s ease;
  transform-origin: center;

  .member-card:hover & {
    transform: scale(1.08);
  }

  &::before {
    /* 主题色渐变光环（跟随队伍强调色；无强调色时回退为蓝紫渐变） */
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 2px;
    background: linear-gradient(
      135deg,
      var(--avatar-accent, #4f6ef7),
      var(--avatar-accent, #a94ff7) 60%,
      var(--avatar-accent, #50c8ff)
    );
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    opacity: 0.85;
  }

  &::after {
    /* 顶部高光：营造玻璃质感 */
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(160deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 45%);
    pointer-events: none;
  }

  /* 圆形头像本身 */
  .avatar {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    border-radius: 50%;
    overflow: hidden;
    background: var(--el-fill-color-light);
  }
}

/* 悬浮流光环：锥形渐变沿环转动，只靠 opacity 淡入淡出，避免动 background（不可过渡） */
.avatar-flow {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
  padding: 2px;
  background: conic-gradient(
    from 0deg,
    transparent 0%,
    var(--avatar-accent, #4f6ef7) 16%,
    transparent 38%,
    var(--avatar-accent, #a94ff7) 62%,
    transparent 86%
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;

  .member-card:hover & {
    opacity: 1;
    animation: spin 2.4s linear infinite;
  }
}

/* 排名皇冠徽章：头像左上角，队色皇冠（MediaIcon 实心壳）+ 内嵌数字；屏蔽后隐藏 */
.rank-crown {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  display: inline-flex;
  pointer-events: none;
  transition: opacity 0.15s ease;

  /* 队色皇冠：沿用 avatar-wrap 注入的 --avatar-accent；无队色回退金色 */
  .media-icon {
    color: var(--avatar-accent, var(--color-follow));
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
  }

  /* 排名数字：叠加在皇冠图形内部偏下的位置 */
  &__num {
    position: absolute;
    left: 50%;
    bottom: 8px;
    transform: translateX(-50%);
    padding: 0 1px;
    border-radius: var(--radius-xs);
    font-size: 11px;
    font-weight: 800;
    line-height: 1.3;
    text-align: center;
    color: #fff;
    text-shadow: 0 0 2px color-mix(in srgb, var(--avatar-accent, var(--color-follow)) 70%, transparent);
  }
}

/* 总选前三名：皇冠改鎏金并做呼吸光，与队色皇冠拉开层级 */
.member-card.is-top-rank .rank-crown .media-icon {
  color: #f0a020;
  animation: crown-shine 2.4s ease-in-out infinite;
}

@keyframes crown-shine {
  0%,
  100% {
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 2px rgba(240, 160, 32, 0.5));
  }

  50% {
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 7px rgba(240, 160, 32, 0.95));
  }
}

/* 关注 / 屏蔽：一对按钮，始终同处头像下沿，悬浮时自下浮出，不挡脸也不挤动名字。
 * 「已关注」的状态不在这里表达 —— 由头像外圈的金色虚线环常驻承担（见 .is-followed），
 * 所以按钮不必常驻，也就不会出现「一个孤零零的实心圆钮挂在头像下巴上」。 */
.quick-actions {
  position: absolute;
  bottom: -3px;
  left: 50%;
  z-index: 4;
  display: flex;
  gap: 4px;
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;

  .member-card:hover & {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

.quick-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  font-family: inherit;
  color: var(--el-text-color-regular);
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background-color 0.15s ease,
    transform 0.15s ease;

  &:hover {
    transform: scale(1.1);
  }

  /* 已启用：图标转白压在语义色实底上，且不随悬浮放大。
   * 这里不能写 opacity —— 父级 .quick-actions 是 opacity: 0 门控，
   * 子级的 opacity 与 0 相乘仍然是 0，写了也是死的。 */
  &.is-on {
    color: #fff;
    transform: scale(1);
  }

  &--follow.is-on {
    background: var(--color-follow);
  }

  &--block.is-on {
    background: var(--el-color-danger);
  }
}

.member-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  width: 100%;
  margin-top: 14px;
  padding: 0 4px;
  text-align: center;

  p {
    margin: 0;
  }
}

.member-name {
  width: 100%;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* 第二行：昵称 · 期数（常驻显示） */
.member-sub {
  width: 100%;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

/* 搜索命中片段：品牌紫淡底高亮 */
.is-hit {
  padding: 0 1px;
  border-radius: 3px;
  color: var(--brand-primary-dark);
  background: rgba(var(--brand-rgb), 0.16);
}

/* 已屏蔽：头像去色弱化，排名装饰隐藏 */
.member-card.is-blocked {
  .avatar {
    filter: grayscale(1);
    opacity: 0.55;
  }

  .rank-crown {
    display: none;
  }
}

/* ===== 已关注：头像外圈加一道金色虚线环 =====
 * 为什么是「虚线」而不是「换色」：原来的做法是把队色环整个换成关注金，
 * 但队色是任意色，迟早有队伍撞上 —— CKG48 的 #FFBA07 与关注金 #ffc53d
 * 在 OKLab 下 ΔE 只有 0.0275（肉眼判定为同一色），那几个成员的「已关注」
 * 等于完全没有信号。
 * 虚线是纹理差异、与颜色无关，所以同色也分得开：队色实线环完整保留，
 * 两个信息同时在场，而不是用一个顶掉另一个。
 * 用 outline 而不是 border/新元素：outline 不参与布局（不会把头像撑大、
 * 不会挤动旁边的卡片），且会跟随 border-radius，所以圆头像是圆环。
 * 挂在 .avatar-wrap 上是为了让它跟着悬浮时的 scale(1.08) 一起缩放。 */
.member-card.is-followed .avatar-wrap {
  outline: 2px dashed var(--color-follow);
  outline-offset: 3px;
}

/* ===== 紧凑档：头像与文案同步收小 =====
 * 皇冠尺寸不在这里 —— MediaIcon 的 size 走内联 style，CSS 覆盖不了，
 * 由 crownSize computed 传 prop，见 script。 */
.member-card.is-compact {
  .avatar-wrap {
    width: 60px;
  }

  .rank-crown__num {
    bottom: 5px;
    font-size: 10px;
  }

  .member-meta {
    gap: 2px;
    margin-top: 10px;
  }

  .member-name {
    font-size: 12px;
  }

  .member-sub {
    font-size: 10px;
  }
}

/* 系统「减少动态效果」下关掉卡片自身的装饰性动画 */
@media (prefers-reduced-motion: reduce) {
  .avatar-flow,
  .member-card.is-top-rank .rank-crown .media-icon {
    animation: none;
  }

  .member-card,
  .avatar-wrap,
  .quick-actions,
  .quick-btn {
    transition: none;
  }

  .member-card:hover {
    transform: none;
  }
}
</style>
