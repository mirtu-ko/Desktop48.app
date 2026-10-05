<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { ArrowLeft, ArrowRight, Close, Film, Hide, Link, Star, StarFilled, User, View } from '@element-plus/icons-vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import Constants from '@renderer/utils/constants'
import Tools from '@renderer/utils/tools'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

/**
 * 成员详情抽屉（两个数据源合并后的唯一详情页）：
 * starInfo 提供头像/写真/微博/状态，allmembers 补齐排名/经历/口头禅/所属公司。
 *
 * 视觉主线是「队色主题」：队伍色以 --accent / --ring 注入抽屉根，
 * 头部氛围、分区标题药丸、指标卡、标签、时间轴节点、画廊选中态全部取这两个变量，
 * 于是同一个组件在不同成员身上呈现不同气质，而不是一张通用信息表。
 */
const props = defineProps<{ member: MemberDetail | null, blocked?: boolean, followed?: boolean }>()
const emit = defineEmits<{ close: [], toggleBlock: [member: MemberDetail], toggleFollow: [member: MemberDetail] }>()

const router = useRouter()

/** 成员状态元信息：使用 Constants.MemberStatusMeta（与成员页分区共用） */
const STATUS_META = Constants.MemberStatusMeta

const statusMeta = computed(() =>
  STATUS_META[props.member?.status ?? 1] || STATUS_META[1],
)

/** 队色可能是裸 HEX（接口口径），统一补上 # 再交给 CSS */
function toHex(color: string | undefined): string {
  const value = (color || '').trim()
  if (!value)
    return ''
  return value.startsWith('#') ? value : `#${value}`
}

/** 分区强调色：成员展示在哪个队伍下就用哪个队伍色 */
const accentColor = computed(() => toHex(props.member?.teamColor) || toHex(props.member?.ringColor))

/** 头像环色：兼任记录取主队色（与成员卡片同口径），其余取队色 */
const ringColor = computed(() => toHex(props.member?.ringColor) || toHex(props.member?.teamColor))

const themeStyle = computed(() => {
  const style: Record<string, string> = {}
  if (accentColor.value)
    style['--accent'] = accentColor.value
  if (ringColor.value)
    style['--ring'] = ringColor.value
  return style
})

/** 成员切换键：兼任记录与本人记录共用 userId，靠 adjunctId 区分，用于重放入场动画 */
const memberKey = computed(() =>
  `${props.member?.userId ?? props.member?.sid ?? ''}-${props.member?.adjunctId ?? ''}`,
)

/**
 * 指标卡：只保留「一眼抓重点」的三项，空值不占位。
 * 排名用皇冠图标（与成员卡片头像上的皇冠同一枚 MediaIcon）。
 */
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

/** 特长 / 兴趣爱好是自由文本，按常见分隔符拆成药丸标签 */
const TAG_SPLIT_REGEX = /[,，、;；/|]+/

function toTags(value: string | undefined): string[] {
  return (value || '').split(TAG_SPLIT_REGEX).map(tag => tag.trim()).filter(Boolean)
}

const specialtyTags = computed(() => toTags(props.member?.specialty))
const hobbyTags = computed(() => toTags(props.member?.hobbies))

/** 经历：接口用 <br> 分行，按 <br>/<br/> 拆成行数组渲染（避免 v-html 引入 XSS） */
const experienceLines = computed(() =>
  (props.member?.experience || '').split(/<br\s*\/?>/i).map(line => line.trim()).filter(Boolean),
)

/** 官网独有的补充成员没有口袋 userId：屏蔽与回放入口都不可用 */
const actionable = computed(() => typeof props.member?.userId === 'number')

/** ===== 写真画廊：大图 + 缩略图条 + 计数，无灯箱（写真尺寸不大，全屏看无意义） ===== */
const photos = computed(() => props.member?.photos ?? [])
const photoIndex = ref(0)
const currentPhoto = computed(() => photos.value[photoIndex.value] ?? '')
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

/** ===== 滚动：滚过头部后浮出吸顶迷你条（小头像 + 名字 + 快捷操作） ===== */
const scrollRef = ref<HTMLElement>()
const scrolled = ref(false)

function onScroll() {
  scrolled.value = (scrollRef.value?.scrollTop ?? 0) > 96
}

/** 切换成员：回到第一张写真与顶部，避免旧索引指向不存在的照片 */
watch(() => props.member, () => {
  photoIndex.value = 0
  scrolled.value = false
  scrollRef.value?.scrollTo({ top: 0 })
}, { flush: 'post' })

/** ===== 关注 / 屏蔽：点击时图标回弹 + 光圈扩散 =====
 * 用自增计数驱动 :key 重挂图标节点，动画才能在同一个人身上反复播放；
 * 计数从 0 起，首次挂载时 is-pulse 不生效，不会在打开抽屉时无端弹一下 */
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

/** ===== 抽屉宽度：默认 420px，可拖拽调整（resizable），下限与 CSS min-width 保持一致 ===== */
const MIN_DRAWER_WIDTH = 360
const drawerSize = ref('420px')

/**
 * 拖拽结束把实际宽度回写到 size：一是记住用户拖到的宽度，
 * 二是让 el-drawer 重置内部拖拽基准 —— 它只在 size 变化时重置，
 * 否则被 CSS min-width 截断后，下一次拖动会从截断前的值算起，出现一段拖不动的死区。
 */
function onResizeEnd(_event: MouseEvent, size: number) {
  drawerSize.value = `${Math.max(Math.round(size), MIN_DRAWER_WIDTH)}px`
}

/** ===== 键盘快捷键：← / → 切写真，F 关注，B 屏蔽（Esc 关闭由 el-drawer 自带） ===== */
function onKeydown(event: KeyboardEvent) {
  if (!props.member)
    return
  const target = event.target as HTMLElement | null
  // 焦点在输入控件里时不抢按键（抽屉内暂无输入框，防的是宿主页面）
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
  else if (key === 'f' && actionable.value) {
    onFollow()
  }
  else if (key === 'b' && actionable.value) {
    onBlock()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/** 关闭抽屉（点击遮罩 / ESC / 关闭按钮） */
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
  <el-drawer
    class="member-drawer"
    body-class="member-drawer__body"
    :model-value="!!member"
    :size="drawerSize"
    :with-header="false"
    resizable
    @update:model-value="onVisibilityChange"
    @resize-end="onResizeEnd"
  >
    <div v-if="member" class="shell" :style="themeStyle">
      <!-- 吸顶迷你条：滚过头部后接管「我是谁 + 能做什么」 -->
      <transition name="mini">
        <div v-show="scrolled" class="mini-bar">
          <el-image class="mini-avatar" :src="member.avatar" fit="cover">
            <template #error>
              <div class="media-ph" />
            </template>
          </el-image>
          <span class="mini-name ellipsis">{{ member.realName }}</span>
          <template v-if="actionable">
            <button
              class="mini-btn"
              :class="{ 'is-on': followed }"
              :title="followed ? '取消关注' : '关注'"
              @click="onFollow"
            >
              <el-icon :size="14">
                <StarFilled v-if="followed" />
                <Star v-else />
              </el-icon>
            </button>
            <button
              class="mini-btn mini-btn--danger"
              :class="{ 'is-on': blocked }"
              :title="blocked ? '解除屏蔽' : '屏蔽'"
              @click="onBlock"
            >
              <el-icon :size="14">
                <Hide v-if="blocked" />
                <View v-else />
              </el-icon>
            </button>
          </template>
          <button class="mini-btn" title="关闭" @click="emit('close')">
            <el-icon :size="15">
              <Close />
            </el-icon>
          </button>
        </div>
      </transition>

      <div ref="scrollRef" class="scroll" @scroll.passive="onScroll">
        <!-- ===== 沉浸式头部：队色底 + 首张写真虚化氛围 ===== -->
        <div :key="`hero-${memberKey}`" class="hero">
          <div
            v-if="member.photos.length"
            class="hero-bg"
            :style="{ backgroundImage: `url(${member.photos[0]})` }"
          />
          <div class="hero-scrim" />

          <button class="hero-close" title="关闭" @click="emit('close')">
            <el-icon :size="15">
              <Close />
            </el-icon>
          </button>

          <div class="hero-main">
            <!-- 头像环：兼任成员取主队色；已关注换鎏金，已屏蔽去色弱化（与成员卡片同一套语言） -->
            <div class="avatar-ring" :class="{ 'is-followed': followed, 'is-blocked': blocked }">
              <el-image class="avatar" :src="member.avatar" fit="cover">
                <template #placeholder>
                  <div class="media-ph" />
                </template>
                <template #error>
                  <div class="media-ph">
                    <el-icon :size="28">
                      <User />
                    </el-icon>
                  </div>
                </template>
              </el-image>
            </div>

            <div class="hero-info">
              <div class="name-row">
                <p class="name ellipsis" :title="member.realName">
                  {{ member.realName }}
                </p>
                <span
                  v-if="member.teamName"
                  class="team-badge"
                  :style="member.teamColor ? { '--tb-color': `#${member.teamColor}` } : undefined"
                >
                  {{ Tools.shortTeamName(member.teamName) }}
                </span>
              </div>
              <div class="tags">
                <!-- 关注 / 屏蔽状态：图标形态表达（实心 = 已启用），不用文案标签；两者互斥 -->
                <span v-if="followed" class="state-icon state-icon--follow" title="已关注">
                  <el-icon :size="12">
                    <StarFilled />
                  </el-icon>
                </span>
                <span v-if="blocked" class="state-icon state-icon--block" title="已屏蔽">
                  <el-icon :size="12">
                    <Hide />
                  </el-icon>
                </span>
                <el-tag :type="statusMeta.tag" size="small" effect="light">
                  {{ statusMeta.label }}
                </el-tag>
                <span v-if="member.groupName" class="group-chip">
                  {{ member.groupName }}
                </span>
                <span v-if="member.abbr" class="group-chip">
                  {{ member.abbr }}
                </span>
              </div>
              <p v-if="member.nickname" class="nick ellipsis" :title="member.nickname">
                {{ member.nickname }}
              </p>
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
            </div>
          </div>

          <!-- 指标卡：总选排名 / 期数 / 身高（空值不占位） -->
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
        </div>

        <!-- ===== 正文：抽屉拖宽后由容器查询自动切成两栏（左资料 / 右写真） ===== -->
        <div :key="`body-${memberKey}`" class="body">
          <div class="col-info">
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

          <div v-if="photos.length" class="col-photos">
            <section class="sec">
              <div class="sec-head">
                <div class="section-title">
                  写真
                </div>
                <span v-if="multiPhotos" class="photo-count">{{ photoIndex + 1 }} / {{ photos.length }}</span>
              </div>
              <div class="gallery-stage">
                <el-image class="gallery-img" :src="currentPhoto" fit="cover" :draggable="false">
                  <template #placeholder>
                    <div class="photo-ph" />
                  </template>
                  <template #error>
                    <div class="photo-ph" />
                  </template>
                </el-image>
                <template v-if="multiPhotos">
                  <button class="gallery-nav gallery-nav--prev" title="上一张" @click="stepPhoto(-1)">
                    <el-icon :size="15">
                      <ArrowLeft />
                    </el-icon>
                  </button>
                  <button class="gallery-nav gallery-nav--next" title="下一张" @click="stepPhoto(1)">
                    <el-icon :size="15">
                      <ArrowRight />
                    </el-icon>
                  </button>
                </template>
              </div>
              <div v-if="multiPhotos" class="gallery-thumbs">
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
              </div>
            </section>
          </div>
        </div>
      </div>

      <!-- 吸底操作条：滚到经历 / 写真也不用把页面滚回去才能点 -->
      <div v-if="actionable" class="action-bar">
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
      </div>
    </div>
  </el-drawer>
</template>

<!-- el-drawer 挂载到 body，scoped 选择器够不到抽屉自身的节点，
     故抽屉外壳与 body 的覆写单独放在这个非 scoped 块里，用命名空间类收敛影响面 -->
<style lang="scss">
.member-drawer.el-drawer {
  /* 抽屉可拖拽调宽：给一个下限，避免拖到极限把版式压垮。
   * 下限值须与组件里的 MIN_DRAWER_WIDTH 保持一致 */
  min-width: 360px;
  max-width: 96vw;
}

/* 内容自带内边距（头部要通铺到边），清掉抽屉默认的 20px；滚动交给组件内部的 .scroll */
.el-drawer__body.member-drawer__body {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
</style>

<style scoped lang="scss">
/* ===== 抽屉骨架：吸顶迷你条 + 滚动区 + 吸底操作条 ===== */
.shell {
  /* 队色兜底：没有队伍色时退回品牌紫，后续所有强调色都读这两个变量 */
  --accent: var(--brand-primary);
  --ring: var(--brand-primary);
  /* 亮色队色（如 SNH48 的浅蓝）直接当文字色对比度不够，混深后再用于文字 */
  --accent-ink: color-mix(in srgb, var(--accent) 62%, #24223a);

  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 容器查询基准：抽屉拖宽后正文自动切两栏（见 .body） */
  container-type: inline-size;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

/* ===== 沉浸式头部 ===== */
.hero {
  position: relative;
  padding: 18px 20px 16px;
  overflow: hidden;
  background: color-mix(in srgb, var(--accent) 12%, var(--el-bg-color));
}

/* 首张写真虚化铺底：只给氛围，不给细节，放大后 blur 才不会在边缘露白 */
.hero-bg {
  position: absolute;
  inset: -20%;
  background-position: center 18%;
  background-size: cover;
  filter: blur(30px) saturate(1.5);
  opacity: 0.3;
  pointer-events: none;
}

/* 白色纱罩：压住虚化底图，保证姓名等深色文字始终可读 */
.hero-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.78) 62%, var(--el-bg-color));
  pointer-events: none;
}

.hero-close {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: rgba(255, 255, 255, 0.72);
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    transform 0.25s ease;

  &:hover {
    color: var(--el-color-danger);
    background: #fff;
    transform: rotate(90deg);
  }
}

.hero-main {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 16px;
  align-items: center;
}

/* 头像环：锥形渐变在 ::before 上转（不能转到头像本身），avatar 靠白圈把渐变收成一道细环 */
.avatar-ring {
  position: relative;
  flex: none;
  width: 96px;
  height: 96px;
  padding: 3px;
  border-radius: 50%;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(
      from 0deg,
      var(--ring),
      color-mix(in srgb, var(--ring) 22%, #fff) 38%,
      var(--ring) 62%,
      color-mix(in srgb, var(--ring) 45%, #fff)
    );
    animation: spin 9s linear infinite;
  }

  .avatar {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    overflow: hidden;
    background: var(--el-fill-color-light);
    box-shadow: 0 0 0 3px var(--el-bg-color);
  }

  /* 已关注：换鎏金环（与成员卡片一致） */
  &.is-followed {
    --ring: var(--color-follow);
  }

  /* 已屏蔽：头像去色弱化 */
  &.is-blocked .avatar {
    filter: grayscale(1);
    opacity: 0.55;
  }
}

.hero-info {
  min-width: 0;
  flex: 1;

  .name-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .name {
    min-width: 0;
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--el-text-color-primary);
  }

  .tags {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  .nick {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }
}

/* 关注 / 屏蔽状态图标：与成员卡片同一套语言（语义色实底 + 白色实心图标） */
.state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #fff;

  &--follow {
    background: var(--color-follow);
  }

  &--block {
    background: var(--el-color-danger);
  }
}

.group-chip {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
}

.weibo-link {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-top: 8px;
  font-size: 14px;
  color: var(--el-color-primary);
  text-decoration: none;

  .link-icon {
    font-size: 13px;
  }

  &:hover {
    text-decoration: underline;
  }
}

/* ===== 指标卡 ===== */
.stats {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.stat {
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.7);

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

/* ===== 正文：默认单栏，抽屉拖宽后切两栏 ===== */
.body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  padding: 16px 20px 24px;
}

@container (min-width: 620px) {
  .body {
    grid-template-columns: minmax(0, 1.2fr) minmax(240px, 1fr);
    align-items: start;
  }
}

.col-info,
.col-photos {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}

/* 分区标题复用全局 .section-title（队色药丸 + 渐隐细线），
 * 只改字号与间距：抽屉里 16px/700 的分区标题过重 */
.sec .section-title {
  --st-accent: var(--accent);

  margin: 0 0 10px;
  font-size: 14px;
}

.sec-head {
  display: flex;
  gap: 10px;
  align-items: center;

  .section-title {
    flex: 1;
    min-width: 0;
  }
}

.photo-count {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
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

/* ===== 写真画廊：大图 + 箭头 + 缩略图条 ===== */
.gallery-stage {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--el-fill-color-light);
  box-shadow: var(--shadow-sm);
}

.gallery-img,
.gallery-img :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

.photo-ph {
  width: 100%;
  height: 100%;
  background: var(--el-fill-color-light);
}

.gallery-nav {
  position: absolute;
  top: 50%;
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
  transition:
    background-color 0.2s ease,
    opacity 0.2s ease;

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

.gallery-thumbs {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  margin-top: 8px;
}

.thumb {
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--el-fill-color-light);
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;

  &:hover {
    opacity: 0.85;
    transform: translateY(-1px);
  }

  &.is-active {
    opacity: 1;
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-sm);
  }
}

.thumb-img {
  display: block;
  width: 100%;
  height: 100%;
}

/* ===== 吸底操作条 ===== */
.action-bar {
  flex: none;
  display: flex;
  /* 三个操作并存时宽度接近抽屉下限，允许换行兜底，避免按钮被压到文字溢出 */
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color) 88%, transparent);
  backdrop-filter: blur(18px) saturate(180%);
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
    flex: 1 1 auto;
    min-width: 120px;
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

/* ===== 吸顶迷你条 ===== */
.mini-bar {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 5;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: color-mix(in srgb, var(--el-bg-color) 84%, transparent);
  backdrop-filter: blur(18px) saturate(180%);
}

.mini-avatar {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 55%, transparent);
}

.mini-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.mini-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease;

  &:hover {
    color: var(--el-color-primary);
    background: var(--el-fill-color-light);
  }

  &.is-on {
    color: var(--color-follow);
  }

  &--danger.is-on {
    color: var(--el-color-danger);
  }
}

.mini-enter-active,
.mini-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.mini-enter-from,
.mini-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

/* ===== 入场：各分区错峰上浮。正文与头部按 memberKey 重挂，切换成员时重放 ===== */
.hero-main,
.stats,
.col-info > *,
.col-photos > * {
  animation: enter-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.hero-main {
  animation-delay: 0.04s;
}

.stats {
  animation-delay: 0.08s;
}

.col-info > *:nth-child(1),
.col-photos > *:nth-child(1) {
  animation-delay: 0.12s;
}

.col-info > *:nth-child(2),
.col-photos > *:nth-child(2) {
  animation-delay: 0.16s;
}

.col-info > *:nth-child(3) {
  animation-delay: 0.2s;
}

.col-info > *:nth-child(4) {
  animation-delay: 0.24s;
}

@keyframes enter-up {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* 系统「减少动态效果」下关掉全部装饰性动画 */
@media (prefers-reduced-motion: reduce) {
  .hero-main,
  .stats,
  .col-info > *,
  .col-photos > * {
    animation: none;
  }

  .avatar-ring::before {
    animation: none;
  }

  .chip,
  .thumb,
  .act,
  .gallery-nav,
  .hero-close {
    transition: none;
  }
}
</style>
