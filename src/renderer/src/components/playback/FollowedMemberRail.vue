<script setup lang="ts">
import type { FollowedMemberEntry } from '@renderer/composables/use-followed-member-entries'
import { ArrowDown, ArrowUp, Close, StarFilled } from '@element-plus/icons-vue'
import Tools from '@renderer/utils/tools'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 回放页的关注成员快速筛选条：一排圆形头像，点击只看某人的回放，再次点击同一项取消筛选。
 *
 * 纯展示组件：成员条目由 useFollowedMemberEntries 提供，选中态由父级持有
 * （与右上角级联筛选共用同一个筛选轴，见 pages/Playbacks.vue）。
 *
 * 版式：贴在右上角筛选器左侧（同一组），自身也是一枚磨砂胶囊（与它共用 .frosted-surface），
 * 整页不额外占纵向空间。宽度自适应：内容短时贴合内容，内容长了先压缩自己（轨道横向滚动 +
 * 两端渐隐），不去挤右侧的筛选控件。折叠入口固定在最左端，不随轨道滚动。
 * 条目只留头像不带姓名：姓名放进 title / aria-label，一条能放下的人数是带姓名时的两倍多。
 *
 * 条目取舍：默认只放在役成员，暂休 / 退团 / 荣誉毕业生收进「+N」折叠区。
 * 关注名单是长期累积的，绝大多数历史关注已无回放可筛，铺开会把在役成员挤到裁切外。
 */
const props = withDefaults(defineProps<{
  members: FollowedMemberEntry[]
  /** 当前生效的筛选成员（null = 未筛选） */
  activeUserId?: string | null
}>(), {
  activeUserId: null,
})

const emit = defineEmits<{ select: [userId: string] }>()

const trackRef = ref<HTMLElement>()

/** 折叠区是否展开（默认收起：只看在役） */
const expanded = ref(false)

const activeMembers = computed(() => props.members.filter(member => member.active))
const restMembers = computed(() => props.members.filter(member => !member.active))

/** 两组都在时才有折叠的意义；整条关注都是非现役时直接铺开，否则只会剩一个「+N」 */
const collapsible = computed(() => activeMembers.value.length > 0 && restMembers.value.length > 0)

/**
 * 折叠时仍然要露出的非现役成员：正被筛中的那一位。
 * 从成员页跳到暂休成员时，选中项不能因为折叠而消失（否则看不到筛选来自谁）。
 */
const pinnedMembers = computed(() =>
  restMembers.value.filter(member => member.userId === props.activeUserId),
)

/** 实际渲染的条目：在役在前、非现役在后；折叠时只留非现役里的选中项 */
const items = computed(() => {
  const list = !collapsible.value || expanded.value
    ? [...activeMembers.value, ...restMembers.value]
    : [...activeMembers.value, ...pinnedMembers.value]
  return list.map((member, index) => ({
    member,
    // 在役与非现役之间加一道细分隔线，展开后一眼看出分组
    divider: index > 0 && !member.active && !!list[index - 1]?.active,
  }))
})

/** 轨道两端是否还有被裁掉的条目：据此给同侧加渐隐，提示可横向滚动 */
const fadeLeft = ref(false)
const fadeRight = ref(false)

function updateFade() {
  const track = trackRef.value
  if (!track)
    return
  fadeLeft.value = track.scrollLeft > 2
  fadeRight.value = track.scrollLeft + track.clientWidth < track.scrollWidth - 2
}

/** 无头像时的兜底字：姓名首字（官方号 / 名录未同步的账号走这条） */
function initial(name: string) {
  return (name || '?').slice(0, 1)
}

/** 条目只显示头像，姓名与动作说明全靠这句（title 与 aria-label 共用） */
function chipLabel(member: FollowedMemberEntry) {
  if (member.userId === props.activeUserId)
    return `取消筛选：${member.name}`
  const status = member.statusLabel ? `（${member.statusLabel}）` : ''
  return `只看 ${member.name} 的回放${status}`
}

/**
 * 纵向滚轮转横向滚动：筛选条通常横向溢出、纵向不滚，
 * 不接管的话滚轮会在这一条上「空转」（与 FloatingTabBar 的处理一致）。
 */
function onWheel(event: WheelEvent) {
  const track = trackRef.value
  if (!track || track.scrollWidth <= track.clientWidth)
    return
  const delta = event.deltaY + event.deltaX
  if (!delta)
    return
  event.preventDefault()
  track.scrollLeft += delta
}

/** 选中项滚入可视区：从成员页跳转 / 选中靠后的成员时，条目不会停在裁切外。
 *  用瞬时滚动而非 smooth：这是 40px 高的一条，位移动画反而晃眼，且被外部状态改动触发时
 *  用户并没有「点击」这个上下文 */
async function revealActive() {
  const userId = props.activeUserId
  if (!userId)
    return
  await nextTick()
  trackRef.value
    ?.querySelector<HTMLElement>(`[data-user-id="${CSS.escape(userId)}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

watch(() => props.activeUserId, revealActive)

function toggleExpanded() {
  expanded.value = !expanded.value
  nextTick(updateFade)
  revealActive()
}

/** 条目增减 / 展开收起都会改变 scrollWidth（不改变轨道自身尺寸），须手动重算渐隐 */
watch(() => items.value.length, () => nextTick(updateFade))

let resizeObserver: ResizeObserver | undefined

onMounted(() => {
  updateFade()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateFade)
    if (trackRef.value)
      resizeObserver.observe(trackRef.value)
  }
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="follow-strip frosted-surface">
    <!-- 语义锚点：一枚鎏金星标（不带文案）。整条只有头像，若无标记就只剩一排人脸 -->
    <span class="follow-strip__mark" title="已关注成员">
      <el-icon :size="12">
        <StarFilled />
      </el-icon>
    </span>

    <div
      ref="trackRef"
      class="follow-strip__track no-scrollbar"
      :class="{ 'fade-left': fadeLeft, 'fade-right': fadeRight }"
      @wheel="onWheel"
      @scroll="updateFade"
    >
      <template v-for="item in items" :key="item.member.userId">
        <span v-if="item.divider" class="follow-strip__divider" aria-hidden="true" />
        <button
          type="button"
          class="follow-chip"
          :class="{ 'is-active': item.member.userId === activeUserId, 'is-rest': !item.member.active }"
          :data-user-id="item.member.userId"
          :aria-pressed="item.member.userId === activeUserId"
          :aria-label="chipLabel(item.member)"
          :title="chipLabel(item.member)"
          @click="emit('select', item.member.userId)"
        >
          <span class="follow-chip__avatar" :style="Tools.colorVarStyle('--chip-color', item.member.color)">
            <el-image class="follow-chip__img" :src="item.member.avatar" fit="cover" lazy>
              <template #placeholder>
                <span class="follow-chip__letter">{{ initial(item.member.name) }}</span>
              </template>
              <template #error>
                <span class="follow-chip__letter">{{ initial(item.member.name) }}</span>
              </template>
            </el-image>
            <!-- 选中角标：没有姓名可加粗，靠这枚小叉同时承担「已选中」与「再点取消」 -->
            <span v-if="item.member.userId === activeUserId" class="follow-chip__clear">
              <el-icon :size="8">
                <Close />
              </el-icon>
            </span>
          </span>
        </button>
      </template>
    </div>

    <!-- 折叠入口：默认收起暂休 / 退团 / 荣誉毕业生，只留一个计数。
         放右端紧接头像排（读完一排再给「还有一批」），且在轨道外 ——
         条目横向溢出时它不跟着一起被滚出去 -->
    <button
      v-if="collapsible"
      type="button"
      class="follow-toggle"
      :class="{ 'is-open': expanded }"
      :aria-expanded="expanded"
      :title="expanded ? '收起暂休 / 退团 / 荣誉毕业生' : '展开暂休 / 退团 / 荣誉毕业生'"
      @click="toggleExpanded"
    >
      <span>{{ expanded ? '收起' : `+${restMembers.length}` }}</span>
      <el-icon :size="9">
        <ArrowUp v-if="expanded" />
        <ArrowDown v-else />
      </el-icon>
    </button>
  </div>
</template>

<style scoped lang="scss">
/* 关注主题色：与直播卡的「已关注」金标同源，整条读作「关注」分组 */
.follow-strip {
  --rail-accent: var(--color-follow);

  /* 与筛选器同组贴右：内容短时贴合内容，长了先压缩自己（轨道横向滚动），
   * 不去挤左侧的 tab 栏与右侧的筛选控件 */
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 4px 内边距 + 32px 头像块 = 40，与右侧工具条（4 + 32）等高，三者齐平 */
  padding: 4px;
  border-radius: var(--radius-pill);
  /* 玻璃底由全局 .frosted-surface 提供，与左上 tab 栏 / 右上工具条同一套 token */
}

/* 语义锚点：一枚鎏金星标，不带文案 —— 整条只有头像，没有标记就只剩一排人脸 */
.follow-strip__mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding-left: 4px;
  color: var(--rail-accent);
  cursor: default;
}

/* 轨道：横向滚动、纵向裁切；两端溢出时用遮罩渐隐代替滚动条 */
.follow-strip__track {
  /* 渐隐只需交代「被裁掉了」，太宽会把整张头像抹成一团浅影 */
  --fade: 14px;

  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;

  /* 尾部留一点空：滚到底时最后一个胶囊不贴着「+N」的边 */
  &::after {
    content: '';
    flex: none;
    width: 4px;
  }

  &.fade-left {
    mask-image: linear-gradient(to right, transparent, #000 var(--fade));
  }

  &.fade-right {
    mask-image: linear-gradient(to right, #000 calc(100% - var(--fade)), transparent);
  }

  &.fade-left.fade-right {
    mask-image: linear-gradient(to right, transparent, #000 var(--fade), #000 calc(100% - var(--fade)), transparent);
  }
}

/* 在役 / 非现役之间的分组线：1px 竖线，展开后才出现 */
.follow-strip__divider {
  flex: none;
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--el-border-color);
}

/* 头像块：没有姓名，32px 见方即点击热区；圆形底片承载悬浮/选中反馈 */
.follow-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    opacity 0.16s ease;

  /* 非现役：整体压暗一档，仍可点，但视觉上退到第二层 */
  &.is-rest {
    opacity: 0.62;
  }

  &:hover {
    background: color-mix(in srgb, var(--rail-accent) 14%, transparent);

    &.is-rest {
      opacity: 1;
    }
  }

  /* 选中：金色底片 + 头像外环（见下）+ 右下角小叉，三者叠加足以在纯头像里读出来 */
  &.is-active {
    opacity: 1;
    background: color-mix(in srgb, var(--rail-accent) 22%, transparent);
  }
}

.follow-chip__avatar {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
}

.follow-chip__img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  overflow: hidden;
  /* 未选中：队色细环（无队色回退中性边线），小头像上只留 1px 不抢视线 */
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--chip-color, var(--el-border-color)) 45%, transparent);
  transition: box-shadow 0.16s ease;
}

.follow-chip:hover .follow-chip__img {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--chip-color, var(--rail-accent)) 70%, transparent);
}

.follow-chip.is-active .follow-chip__img {
  box-shadow:
    0 0 0 1px var(--el-bg-color-page),
    0 0 0 2px var(--rail-accent);
}

.follow-chip__letter {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--chip-color, var(--brand-primary)) 68%, #2b2440);
  background: color-mix(in srgb, var(--chip-color, var(--brand-primary)) 14%, var(--el-bg-color));
}

/* 选中角标：压在头像右下角，金色小圆 + 白叉，落在头像块留白内不占额外宽度 */
.follow-chip__clear {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  color: #fff;
  background: var(--rail-accent);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--el-bg-color) 92%, transparent);
}

/* 折叠入口：与头像块同高的一半左右，虚线环表示「还有一批」 */
.follow-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--el-border-color);
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease,
    box-shadow 0.16s ease;

  &:hover {
    color: var(--el-text-color-primary);
    background: var(--el-fill-color-light);
    box-shadow: inset 0 0 0 1px var(--el-border-color-dark);
  }

  &.is-open {
    color: var(--el-text-color-regular);
  }
}

@media (prefers-reduced-motion: reduce) {
  .follow-chip,
  .follow-chip__img,
  .follow-toggle {
    transition: none;
  }
}
</style>
