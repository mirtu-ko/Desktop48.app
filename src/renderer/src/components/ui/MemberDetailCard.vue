<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Close, Film, Hide, Link, Star, StarFilled, View } from '@element-plus/icons-vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import Constants from '@renderer/utils/constants'
import { toExperienceLines, toTags } from '@renderer/utils/member-text'
import Tools from '@renderer/utils/tools'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

/** 成员详情卡片（两个数据源合并后的唯一详情页）：starInfo 出头像 / 写真 / 微博 / 状态，allmembers 补排名 / 经历 / 口头禅 / 公司。队色以 --accent / --ring 注入卡片根 */
const props = defineProps<{
  member: MemberDetail | null
  blocked?: boolean
  followed?: boolean
  /** 上一个 / 下一个成员是否存在。只有成员页传，其它页不传则 ↑ / ↓ 不响应 */
  hasPrev?: boolean
  hasNext?: boolean
}>()
const emit = defineEmits<{
  close: []
  toggleBlock: [member: MemberDetail]
  toggleFollow: [member: MemberDetail]
  prev: []
  next: []
}>()

const router = useRouter()

/** 成员状态元信息：使用 Constants.MemberStatusMeta（与成员页分区共用） */
const STATUS_META = Constants.MemberStatusMeta

const statusMeta = computed(() =>
  STATUS_META[props.member?.status ?? 1] || STATUS_META[1],
)

/** 队色可能是裸 HEX（接口口径），统一补上 # 再交给 CSS；口径见 utils/tools.ts 的 toHex */
const accentColor = computed(() => Tools.toHex(props.member?.teamColor) || Tools.toHex(props.member?.ringColor))

/** 头像环色：兼任记录取主队色（与成员卡片同口径），其余取队色 */
const ringColor = computed(() => Tools.toHex(props.member?.ringColor) || Tools.toHex(props.member?.teamColor))

const themeStyle = computed(() => {
  const style: Record<string, string> = {}
  if (accentColor.value)
    style['--accent'] = accentColor.value
  if (ringColor.value)
    style['--ring'] = ringColor.value
  return style
})

/** 队伍药丸的队色变量（无队色时不注入，交给 .team-badge 的默认灰兜底） */
const teamBadgeStyle = computed(() => Tools.colorVarStyle('--tb-color', props.member?.teamColor))

/** 成员切换键：兼任记录与本人记录共用 userId，靠 adjunctId 区分，用于重放入场动画 */
const memberKey = computed(() =>
  `${props.member?.userId ?? props.member?.sid ?? ''}-${props.member?.adjunctId ?? ''}`,
)

/** 指标卡：总选排名 / 期数 / 身高三项，空值不占位。排名用皇冠图标（与成员卡片同一枚 MediaIcon） */
const stats = computed(() => {
  const member = props.member
  if (!member)
    return []
  return [
    { key: 'rank', label: '总选排名', value: member.ranking ? `第 ${member.ranking} 名` : '', crown: true },
    { key: 'period', label: '期数', value: member.periodName, crown: false },
    { key: 'height', label: '身高', value: member.height ? `${member.height}cm` : '', crown: false },
  ].filter(item => item.value)
})

/** 基础资料（空值字段不展示；期数/身高已提到指标卡，这里不重复） */
const profileItems = computed(() => {
  const member = props.member
  if (!member)
    return []
  return [
    { label: '生日', value: member.birthday },
    { label: '星座', value: member.constellation },
    { label: '血型', value: member.bloodType },
    { label: '出生地', value: member.birthplace },
    { label: '入团时间', value: member.joinTime },
    { label: '所属公司', value: member.company },
  ].filter(item => item.value)
})

/** 特长 / 兴趣爱好是自由文本，按常见分隔符拆成药丸标签；解析口径见 utils/member-text.ts */
const specialtyTags = computed(() => toTags(props.member?.specialty))
const hobbyTags = computed(() => toTags(props.member?.hobbies))

/** 经历：接口用 <br> 分行，拆成行数组渲染（避免 v-html 引入 XSS） */
const experienceLines = computed(() => toExperienceLines(props.member?.experience))

/** 官网独有的补充成员没有口袋 userId：屏蔽与回放入口都不可用 */
const actionable = computed(() => typeof props.member?.userId === 'number')

/** ===== 左栏立绘：写真轮播 + 缩略图条。无写真时退回头像，避免立绘位空掉 ===== */
const photos = computed(() => props.member?.photos ?? [])
const photoIndex = ref(0)
const currentPhoto = computed(() => photos.value[photoIndex.value] ?? '')
const portraitSrc = computed(() => currentPhoto.value || props.member?.avatar || '')
const multiPhotos = computed(() => photos.value.length > 1)

function stepPhoto(delta: number) {
  const total = photos.value.length
  if (total < 2)
    return
  photoIndex.value = (photoIndex.value + delta + total) % total
}

function selectPhoto(index: number) {
  photoIndex.value = index
}

/** ===== 右栏信息：独立滚动，切成员时回到顶部 ===== */
const infoRef = ref<HTMLElement>()

/** 切换成员：回到第一张写真与信息栏顶部，避免旧索引指向不存在的照片 */
watch(() => props.member, () => {
  photoIndex.value = 0
  infoRef.value?.scrollTo({ top: 0 })
}, { flush: 'post' })

/** ===== 关注 / 屏蔽：点击时图标回弹 + 光圈扩散 ===== 自增计数驱动 :key 重挂图标节点，动画才能反复播放；计数从 0 起，首次挂载不弹 */
const followPulse = ref(0)
const blockPulse = ref(0)

function onFollow() {
  if (!props.member)
    return
  followPulse.value += 1
  emit('toggleFollow', props.member)
}

function onBlock() {
  if (!props.member)
    return
  blockPulse.value += 1
  emit('toggleBlock', props.member)
}

/** ===== 键盘：← / → 切写真，↑ / ↓ 切成员（仅成员页），F 关注，B 屏蔽，Esc 关闭由 el-dialog 自带 ===== */
function onKeydown(event: KeyboardEvent) {
  if (!props.member)
    return
  const target = event.target as HTMLElement | null
  // 焦点在输入控件里时不抢按键（卡片内暂无输入框，防的是宿主页面）
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    return
  const key = event.key.toLowerCase()
  if (key === 'arrowleft') {
    event.preventDefault()
    stepPhoto(-1)
  }
  else if (key === 'arrowright') {
    event.preventDefault()
    stepPhoto(1)
  }
  else if (key === 'arrowup' && props.hasPrev) {
    event.preventDefault()
    emit('prev')
  }
  else if (key === 'arrowdown' && props.hasNext) {
    event.preventDefault()
    emit('next')
  }
  else if (key === 'f' && actionable.value) {
    onFollow()
  }
  else if (key === 'b' && actionable.value) {
    onBlock()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 关闭卡片（点击蒙版 / ESC / 关闭按钮） */
function onVisibilityChange(value: boolean) {
  if (!value)
    emit('close')
}

/** 跳转回放页并预置成员筛选 */
function openPlaybacks() {
  if (!props.member?.userId)
    return
  emit('close')
  router.push({ path: '/lives/playbacks', query: { member: String(props.member.userId) } })
}
</script>

<template>
  <el-dialog
    class="detail-card-dialog"
    modal-class="detail-card-overlay"
    :model-value="!!member"
    :show-close="false"
    align-center
    append-to-body
    @update:model-value="onVisibilityChange"
  >
    <div v-if="member" :key="memberKey" class="detail-card" :style="themeStyle">
      <div class="card-main">
        <!-- 左栏立绘：写真通铺到卡片边缘，信息浮在图上 -->
        <div class="portrait">
          <el-image class="portrait-img" :src="portraitSrc" fit="cover" :draggable="false">
            <template #placeholder>
              <div class="media-ph" />
            </template>
            <template #error>
              <div class="media-ph" />
            </template>
          </el-image>
          <div class="portrait-scrim" />

          <!-- 关注 / 屏蔽互斥，用 v-else-if 而非两个独立条件 -->
          <span v-if="followed" class="flag flag--follow">
            <el-icon><StarFilled /></el-icon>
            已关注
          </span>
          <span v-else-if="blocked" class="flag flag--block">
            <el-icon><Hide /></el-icon>
            已屏蔽
          </span>

          <button class="detail-close" title="关闭" @click="emit('close')">
            <el-icon :size="15">
              <Close />
            </el-icon>
          </button>

          <template v-if="multiPhotos">
            <button class="photo-nav photo-nav--prev" title="上一张" @click="stepPhoto(-1)">
              <el-icon :size="15">
                <ArrowLeft />
              </el-icon>
            </button>
            <button class="photo-nav photo-nav--next" title="下一张" @click="stepPhoto(1)">
              <el-icon :size="15">
                <ArrowRight />
              </el-icon>
            </button>
          </template>

          <div class="portrait-foot">
            <p class="p-name" :title="member.realName">
              {{ member.realName }}
            </p>
            <div class="p-chips">
              <span
                v-if="member.teamName"
                class="team-badge"
                :style="teamBadgeStyle"
              >
                {{ Tools.shortTeamName(member.teamName) }}
              </span>
              <el-tag :type="statusMeta.tag" size="small" effect="light">
                {{ statusMeta.label }}
              </el-tag>
            </div>
            <p class="p-sub">
              <span v-if="member.nickname">{{ member.nickname }}</span>
              <span v-if="member.nickname && member.groupName"> · </span>
              <span v-if="member.groupName">{{ member.groupName }}</span>
              <span v-if="member.abbr"> · {{ member.abbr }}</span>
            </p>

            <div v-if="multiPhotos" class="p-thumbs">
              <button
                v-for="(photo, index) in photos"
                :key="photo"
                class="thumb"
                :class="{ 'is-active': index === photoIndex }"
                :title="`第 ${index + 1} 张`"
                @click="selectPhoto(index)"
              >
                <el-image class="thumb-img" :src="photo" fit="cover" :draggable="false" />
              </button>
              <span class="thumb-count">{{ photoIndex + 1 }} / {{ photos.length }}</span>
            </div>
          </div>
        </div>

        <!-- 右栏信息：卡片定高，只有这一栏滚动 -->
        <div ref="infoRef" class="info detail-scroll">
          <div v-if="stats.length" class="stats">
            <div
              v-for="stat in stats"
              :key="stat.key"
              class="stat"
              :class="{ 'stat--rank': stat.crown }"
            >
              <p class="stat-label">
                {{ stat.label }}
              </p>
              <p class="stat-value">
                <MediaIcon v-if="stat.crown" class="stat-crown" name="crownFilled" :size="14" />
                <span class="ellipsis">{{ stat.value }}</span>
              </p>
            </div>
          </div>

          <a
            v-if="member.wbUid"
            class="weibo-link"
            :href="`https://weibo.com/u/${member.wbUid}`"
            target="_blank"
            rel="noopener"
          >
            {{ member.wbName || member.wbUid }}
            <el-icon class="link-icon">
              <Link />
            </el-icon>
          </a>

          <section v-if="profileItems.length" class="sec">
            <div class="section-title">
              基础资料
            </div>
            <div class="profile-grid">
              <div v-for="item in profileItems" :key="item.label" class="cell">
                <p class="label">
                  {{ item.label }}
                </p>
                <p class="value ellipsis" :title="item.value">
                  {{ item.value }}
                </p>
              </div>
            </div>
          </section>

          <section v-if="specialtyTags.length || hobbyTags.length" class="sec">
            <div class="section-title">
              特长 · 爱好
            </div>
            <div v-if="specialtyTags.length" class="tag-row">
              <span class="tag-row__label">特长</span>
              <div class="chips">
                <span v-for="tag in specialtyTags" :key="`s-${tag}`" class="chip">{{ tag }}</span>
              </div>
            </div>
            <div v-if="hobbyTags.length" class="tag-row">
              <span class="tag-row__label">爱好</span>
              <div class="chips">
                <span v-for="tag in hobbyTags" :key="`h-${tag}`" class="chip">{{ tag }}</span>
              </div>
            </div>
          </section>

          <section v-if="member.catchPhrase" class="sec">
            <div class="section-title">
              口头禅
            </div>
            <p class="quote">
              {{ member.catchPhrase }}
            </p>
          </section>

          <section v-if="experienceLines.length" class="sec">
            <div class="section-title">
              经历
            </div>
            <ul class="timeline">
              <li v-for="(line, index) in experienceLines" :key="index">
                {{ line }}
              </li>
            </ul>
          </section>
        </div>
      </div>

      <!-- 底栏操作条：横贯整张卡片 -->
      <div v-if="actionable" class="card-actions">
        <button class="act act--primary" @click="openPlaybacks">
          <el-icon :size="15">
            <Film />
          </el-icon>
          <span>看 TA 的回放</span>
        </button>
        <button class="act act--follow" :class="{ 'is-on': followed }" @click="onFollow">
          <span :key="followPulse" class="act-icon" :class="{ 'is-pulse': followPulse > 0 }">
            <el-icon :size="15">
              <StarFilled v-if="followed" />
              <Star v-else />
            </el-icon>
          </span>
          <span>{{ followed ? '取消关注' : '关注' }}</span>
        </button>
        <button class="act act--block" :class="{ 'is-on': blocked }" @click="onBlock">
          <span :key="blockPulse" class="act-icon" :class="{ 'is-pulse': blockPulse > 0 }">
            <el-icon :size="15">
              <Hide v-if="blocked" />
              <View v-else />
            </el-icon>
          </span>
          <span>{{ blocked ? '解除屏蔽' : '屏蔽' }}</span>
        </button>

        <span class="act-hint">
          <template v-if="hasPrev || hasNext">
            <el-icon class="hint-icon">
              <ArrowUp />
            </el-icon>
            <el-icon class="hint-icon">
              <ArrowDown />
            </el-icon>
            切换成员 ·
          </template>
          ← → 切写真
          <template v-if="multiPhotos"> · 共 {{ photos.length }} 张</template>
        </span>
      </div>
    </div>
  </el-dialog>
</template>

<!-- 外壳 / 卡面 / 关闭钮 / 滚动列的样式见全局 app.scss 的「详情卡片共用」，这里只留本卡独有的部分 -->
<style scoped lang="scss">
/* ===== 卡片骨架：左立绘 + 右信息 + 底操作条（.detail-card 的基础样式在全局） ===== */
.detail-card {
  /* 队色兜底：没有队伍色时退回品牌紫，后续所有强调色都读这两个变量 */
  --ring: var(--brand-primary);
  /* 亮色队色（如 SNH48 的浅蓝）直接当文字色对比度不够，混深后再用于文字 */
  --accent-ink: color-mix(in srgb, var(--accent) 62%, #24223a);

  flex-direction: column;
}

.card-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ===== 左栏立绘 ===== */
.portrait {
  position: relative;
  /* 窄窗口时立绘收到 220px 为止，不再继续压，剩余宽度全给信息栏 */
  flex: 0 0 clamp(220px, 38%, 380px);
  overflow: hidden;
  background: var(--el-fill-color-light);
}

.portrait-img,
.portrait-img :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

/* 人像通常头顶留白多，取景上移一点保住脸 */
.portrait-img :deep(img) {
  object-position: center 22%;
}

/* 底部压暗保证姓名可读，顶部也轻压一层给状态徽章与关闭钮垫底 */
.portrait-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    rgba(20, 18, 32, 0.34) 0%,
    transparent 26%,
    transparent 44%,
    rgba(20, 18, 32, 0.82) 100%
  );
  pointer-events: none;
}

.flag {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  color: #fff;

  &--follow {
    background: var(--color-follow);
  }

  &--block {
    background: var(--el-color-danger);
  }
}

.photo-nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: #fff;
  background: rgba(15, 17, 26, 0.42);
  backdrop-filter: blur(6px);
  cursor: pointer;
  transform: translateY(-50%);
  transition: background-color 0.2s ease;

  &--prev {
    left: 8px;
  }

  &--next {
    right: 8px;
  }

  &:hover {
    background: rgba(var(--brand-rgb), 0.88);
  }
}

.portrait-foot {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  padding: 14px 16px 12px;
  color: #fff;
}

.p-name {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
}

.p-chips {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}

.p-sub {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.78);
}

.p-thumbs {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-top: 10px;
}

.thumb {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.2);
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 0.9;
  }

  &.is-active {
    opacity: 1;
    box-shadow: 0 0 0 2px #fff;
  }
}

.thumb-img,
.thumb-img :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

.thumb-count {
  margin-left: 3px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  font-variant-numeric: tabular-nums;
}

/* ===== 右栏信息（滚动相关见全局 .detail-scroll） ===== */
.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px;
}

/* ===== 指标卡 ===== */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 8px;
}

.stat {
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--el-fill-color-lighter);

  .stat-label {
    margin: 0;
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }

  .stat-value {
    display: flex;
    gap: 4px;
    align-items: center;
    min-width: 0;
    margin: 2px 0 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--el-text-color-primary);
  }

  /* 排名是荣誉项：整张卡走队色，皇冠跟队色 */
  &--rank .stat-value {
    color: var(--accent-ink);
  }

  &--rank .stat-crown {
    color: var(--ring);
  }
}

.weibo-link {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  align-self: flex-start;
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;

  .link-icon {
    font-size: 13px;
  }

  &:hover {
    text-decoration: underline;
  }
}

/* 复用全局 .section-title（队色药丸），只改字号与间距：全局 15px/600 在卡片里仍偏重；
   卡片自带描边分区，尾部渐隐线与其重复，隐藏 */
.sec .section-title {
  --st-accent: var(--accent);

  margin: 0 0 10px;
  font-size: 14px;

  &::after {
    display: none;
  }
}

.profile-grid {
  display: grid;
  gap: 10px 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--el-fill-color-lighter);

  .cell {
    min-width: 0;
  }

  .label {
    margin: 0;
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }

  .value {
    margin: 2px 0 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }
}

/* ===== 特长 / 爱好：药丸标签 ===== */
.tag-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;

  & + .tag-row {
    margin-top: 10px;
  }

  &__label {
    flex: none;
    padding-top: 3px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.chip {
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  line-height: 1.6;
  color: var(--accent-ink);
  background: color-mix(in srgb, var(--accent) 12%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 48%, transparent);
  }
}

/* ===== 口头禅：队色引用块 ===== */
.quote {
  margin: 0;
  padding: 10px 14px;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: color-mix(in srgb, var(--accent) 8%, var(--el-bg-color));
  font-size: 14px;
  line-height: 1.7;
  color: var(--el-text-color-primary);
  white-space: pre-line;
}

/* ===== 经历：竖向时间轴（首节点用队色实心强调） ===== */
.timeline {
  position: relative;
  margin: 0;
  padding: 2px 0 2px 18px;
  list-style: none;

  &::before {
    content: '';
    position: absolute;
    top: 10px;
    bottom: 10px;
    left: 4px;
    width: 1px;
    background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 8%, transparent));
  }

  li {
    position: relative;
    font-size: 13px;
    line-height: 1.7;
    color: var(--el-text-color-regular);

    & + li {
      margin-top: 8px;
    }

    &::before {
      content: '';
      position: absolute;
      top: 8px;
      left: -18px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--el-bg-color);
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
    }

    &:first-child::before {
      background: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
  }
}

/* ===== 底栏操作条 ===== */
.card-actions {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color) 88%, transparent);
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border: none;
  border-radius: var(--el-border-radius-base);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;

  &:active {
    transform: scale(0.96);
  }

  &--primary {
    flex: none;
    min-width: 140px;
    color: #fff;
    background: var(--gradient-brand);
    box-shadow: var(--shadow-glow);

    &:hover {
      background: var(--gradient-brand-hover);
    }
  }

  &--follow,
  &--block {
    flex: none;
    color: var(--el-text-color-regular);
    background: var(--el-fill-color-light);
    box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);

    &:hover {
      background: var(--el-fill-color);
    }
  }

  /* 已启用：语义色淡底 + 同色描边（与卡片上的实心钮同一套语义色） */
  &--follow.is-on {
    color: var(--color-follow);
    background: color-mix(in srgb, var(--color-follow) 16%, var(--el-bg-color));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-follow) 45%, transparent);
  }

  &--block.is-on {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 12%, var(--el-bg-color));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-color-danger) 42%, transparent);
  }
}

.act-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-placeholder);

  .hint-icon {
    font-size: 12px;
  }
}

/* 点击反馈：图标回弹 + 光圈扩散。两者基态都是「无」，动画播完自然归位 */
.act-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &::after {
    content: '';
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 2px solid currentColor;
    opacity: 0;
    pointer-events: none;
  }

  &.is-pulse {
    animation: act-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);

    &::after {
      animation: act-ripple 0.55s ease-out;
    }
  }
}

@keyframes act-pop {
  0% {
    transform: scale(1);
  }

  45% {
    transform: scale(1.45);
  }

  100% {
    transform: scale(1);
  }
}

@keyframes act-ripple {
  0% {
    opacity: 0.7;
    transform: scale(0.6);
  }

  100% {
    opacity: 0;
    transform: scale(1.6);
  }
}

/* ===== 入场：立绘文案与信息栏错峰上浮。卡片按 memberKey 重挂，切成员时重放 ===== */
.portrait-foot,
.info > * {
  animation: detail-enter 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.portrait-foot {
  animation-delay: 0.04s;
}

/* 信息栏逐块上浮，步长与专辑卡一致。
 * 上限 6：stats / 微博 / 基础资料 / 特长·爱好 / 口头禅 / 经历 最多六块，
 * 少写一块的话最后那块会退回 delay 0，反而排在前面先出现 */
.info {
  @for $i from 1 through 6 {
    > *:nth-child(#{$i}) {
      animation-delay: 0.04s * $i;
    }
  }
}
/* 系统「减少动态效果」下关掉全部装饰性动画 */
@media (prefers-reduced-motion: reduce) {
  .portrait-foot,
  .info > * {
    animation: none;
  }

  .chip,
  .thumb,
  .act,
  .photo-nav,
  .detail-close {
    transition: none;
  }
}
</style>
