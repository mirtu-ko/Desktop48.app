<script setup lang="ts">
import type { LiveListItem } from '@renderer/services/api-types'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { isTraineeTeam } from '@common/member-team-promotion'
import { Star, StarFilled } from '@element-plus/icons-vue'
import RoomPromotionDialog from '@renderer/components/rooms/RoomPromotionDialog.vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { useFloatPlayersStore } from '@renderer/stores/float-players'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import { useMemberTeamPromotionStore } from '@renderer/stores/member-team-promotion'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'

/** 左栏房间条目（PocketRoom 的最小子集；live 为该成员当前在播直播） */
const props = defineProps<{
  userId: number
  nickname: string
  avatar: string
  teamName: string
  teamColor: string
  live: LiveListItem | null
  /** 口袋账号侧是否已关注（未登录 / 本地独有时为 false） */
  pocketFollowed?: boolean
  /** 本机名单里是否已收录（local / both；账号关注的成员同步后也是 true） */
  localFollowed?: boolean
  /** 口袋关注 / 取关请求进行中 */
  pocketFollowBusy?: boolean
  /** 本地关注 / 取关请求进行中 */
  localFollowBusy?: boolean
  /** 口袋关注名单未同步：账号侧状态不可信，主开关禁用并说明原因 */
  pocketUnavailable?: boolean
}>()

/** 关注开关：状态与数据编排留在房间页，卡片只负责展示与触发 */
const emit = defineEmits<{ togglePocketFollow: [], toggleLocalFollow: [] }>()

/**
 * 层级而不是并列：口袋关注是主操作，本机名单只作为状态呈现；
 * 「仅在本机关注 / 移出本机」这类次级操作放在状态行里，按状态决定是否出现。
 */
const localOnly = computed(() => props.pocketFollowed !== true && props.localFollowed === true)
/** 任一请求在途：两个入口互斥，避免并发改出来回跳的状态 */
const followBusy = computed(() => props.pocketFollowBusy === true || props.localFollowBusy === true)
const pocketDisabled = computed(() => props.pocketUnavailable === true || props.localFollowBusy === true)

const pocketTitle = computed(() => {
  if (props.pocketUnavailable)
    return '口袋关注未同步，稍后刷新再试'
  return props.pocketFollowed ? '取消口袋关注（会同步到账号）' : '在口袋账号关注该成员'
})

const { findMemberByUserId } = useMemberDirectoryStore()

/** 名录反查结果：查不到（成员库未同步）时卡片降级只用房间自带字段 */
const member = ref<MemberDetail | null>(null)
const memberLoading = ref(false)

watch(
  () => props.userId,
  async (userId) => {
    member.value = null
    if (!Number.isFinite(Number(userId)))
      return
    memberLoading.value = true
    try {
      member.value = await findMemberByUserId(userId)
    }
    catch {
      member.value = null
    }
    finally {
      memberLoading.value = false
    }
  },
  { immediate: true },
)

const cardAvatar = computed(() => member.value?.avatar || props.avatar)

/** 展示队伍用房间页同一份服务端原值派生，不再用名录反查另起一套口径 */
const { promotionOf, displayTeamOf, clearPromotion } = useMemberTeamPromotionStore()
const shownTeam = computed(() => displayTeamOf(props.userId, props.teamName, props.teamColor))
const promotion = computed(() => promotionOf(props.userId))
const isTrainee = computed(() => isTraineeTeam(props.teamName))

/** 升格三态：还没设 / 她仍是预备生 / 她已正式升格（升格后本地记录可清） */
type PromotionState = 'none' | 'active' | 'fulfilled'
const promotionState = computed<PromotionState>(() => {
  if (!promotion.value)
    return 'none'
  return isTrainee.value ? 'active' : 'fulfilled'
})
const promotionButtonLabel = computed(() => ({
  none: '让她升格（仅本机）',
  active: '调整升格队伍',
  fulfilled: '她已正式升格，点击清除本机记录',
})[promotionState.value])

/** 弹窗开关：队伍目录、预演与写入都在 RoomPromotionDialog 里，这里只管按钮三态 */
const promotionOpen = ref(false)
const clearingRecord = ref(false)

function onPromotionButton() {
  if (promotionState.value === 'fulfilled')
    void clearFulfilledPromotion()
  else
    promotionOpen.value = true
}

/** 她已正式升格：清掉不再生效的本地记录 */
async function clearFulfilledPromotion() {
  if (clearingRecord.value)
    return
  clearingRecord.value = true
  try {
    await clearPromotion(props.userId)
    ElMessage.success(`她已正式升格，${props.nickname} 的本机记录已清除`)
  }
  catch (error) {
    console.error('[RoomProfileCard]清除已升格记录失败:', error)
    ElMessage.error('清除失败，请稍后重试')
  }
  finally {
    clearingRecord.value = false
  }
}

/** 生日行：有生日就带星座，无生日整行隐藏 */
const birthdayLine = computed(() => {
  if (!member.value?.birthday)
    return ''
  return member.value.constellation
    ? `${member.value.birthday}（${member.value.constellation}）`
    : member.value.birthday
})

const liveCover = computed(() => Tools.sourceUrl(props.live?.coverPath || ''))
const liveTime = computed(() => {
  const time = Number.parseInt(props.live?.ctime || '', 10)
  return Number.isFinite(time) && time > 0 ? dayjs(time).format('MM-DD HH:mm') : ''
})

function enterLive() {
  const live = props.live
  if (!live)
    return
  const { openLive } = useFloatPlayersStore()
  openLive({
    liveId: live.liveId,
    nickname: props.nickname,
    title: live.title || `${props.nickname}的直播`,
    startTime: Number.parseInt(live.ctime, 10) || Date.now(),
    liveType: live.liveType,
    liveMode: live.liveMode,
  })
}
</script>

<template>
  <section class="profile-card">
    <div class="profile-head">
      <span class="profile-avatar">
        <img
          v-if="cardAvatar"
          :src="cardAvatar"
          :alt="nickname"
          referrerpolicy="no-referrer"
        >
        <span v-else class="profile-avatar-fallback">{{ nickname.slice(0, 1) }}</span>
      </span>
      <div class="profile-title">
        <h4 class="profile-name ellipsis">
          {{ nickname }}
        </h4>
      </div>
      <button
        v-if="promotionState !== 'none' || isTrainee"
        type="button"
        class="promote-btn"
        :class="{ 'is-revert': promotionState !== 'none', 'is-fulfilled': promotionState === 'fulfilled' }"
        :title="promotionButtonLabel"
        :aria-label="promotionButtonLabel"
        @click="onPromotionButton"
      >
        <span v-if="promotionState === 'none'">升</span>
        <MediaIcon
          v-else
          :name="promotionState === 'fulfilled' ? 'check' : 'undo'"
          :size="11"
        />
      </button>
      <span
        v-if="shownTeam.teamName"
        class="profile-team"
        :style="Tools.colorVarStyle('--tb-color', shownTeam.teamColor)"
      >{{ Tools.shortTeamName(shownTeam.teamName) }}</span>
    </div>

    <dl v-if="member" class="profile-info">
      <div v-if="birthdayLine" class="profile-info-row">
        <dt>生日</dt>
        <dd>{{ birthdayLine }}</dd>
      </div>
      <div v-if="member.groupName" class="profile-info-row">
        <dt>团体</dt>
        <dd>{{ member.groupName }}</dd>
      </div>
      <div v-if="member.joinTime" class="profile-info-row">
        <dt>入团</dt>
        <dd>{{ member.joinTime }}</dd>
      </div>
    </dl>

    <!-- 关注：一枚主开关（口袋账号）+ 一行随状态变化的本机说明。
         本机不是第二个开关——它只回答「房间为什么还在」，并在需要时给出「移出本机」 -->
    <div class="profile-follow">
      <div class="follow-row">
        <span class="follow-label" :title="pocketTitle">
          <el-icon :size="12" class="follow-label-ico" :class="{ 'is-on': pocketFollowed }">
            <StarFilled v-if="pocketFollowed" />
            <Star v-else />
          </el-icon>
          口袋关注
        </span>
        <el-button
          size="small"
          round
          class="follow-btn"
          :class="pocketFollowed ? 'is-remove' : 'is-add'"
          :loading="pocketFollowBusy"
          :disabled="pocketDisabled"
          :title="pocketTitle"
          :aria-label="pocketTitle"
          @click="emit('togglePocketFollow')"
        >
          {{ pocketFollowed ? '取关' : '关注' }}
        </el-button>
      </div>

      <p class="follow-note">
        <template v-if="pocketUnavailable">
          关注状态未同步，稍后刷新再试
        </template>
        <template v-else-if="pocketFollowed">
          <span class="follow-state">已关注</span>
          <span class="follow-dot">·</span>
          {{ localFollowed ? '本机名单随账号同步' : '本机尚未收录，同步后出现' }}
        </template>
        <template v-else-if="localOnly">
          <span class="follow-state">仅在本机关注</span>
          <span class="follow-dot">·</span>
          <button
            type="button"
            class="follow-text-btn"
            :disabled="followBusy"
            @click="emit('toggleLocalFollow')"
          >
            {{ localFollowBusy ? '移出中…' : '移出本机' }}
          </button>
        </template>
        <template v-else>
          关注后会同步到口袋账号
          <span class="follow-dot">·</span>
          <button
            type="button"
            class="follow-text-btn"
            :disabled="followBusy"
            @click="emit('toggleLocalFollow')"
          >
            {{ localFollowBusy ? '记录中…' : '仅在本机关注' }}
          </button>
        </template>
      </p>
    </div>
  </section>

  <!-- 直播状态：独立模块，与资料卡平级（间距由右栏 gap 提供） -->
  <button v-if="live" type="button" class="profile-live" :title="`打开直播播放窗：${live.title || '直播中'}`" @click="enterLive">
    <span class="profile-live-cover">
      <img v-if="liveCover" :src="liveCover" alt="" referrerpolicy="no-referrer">
      <span v-else class="profile-live-ph">LIVE</span>
    </span>
    <span class="profile-live-text">
      <span class="profile-live-badge">直播中</span>
      <span class="profile-live-title ellipsis">{{ live.title || '直播中' }}</span>
      <span v-if="liveTime" class="profile-live-time">{{ liveTime }} 开播</span>
    </span>
    <span class="profile-live-action">进入</span>
  </button>
  <span v-else class="profile-offline">
    未开播
  </span>

  <!-- 预备生升格弹窗：队伍目录与写入都在子组件里，资料卡只给身份与开关 -->
  <RoomPromotionDialog
    v-model="promotionOpen"
    :user-id="userId"
    :nickname="nickname"
    :avatar="cardAvatar"
    :team-name="teamName"
  />
</template>

<style scoped lang="scss">
.profile-card {
  padding: 14px;
  border-radius: var(--radius-card);
  background: var(--el-fill-color-blank);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.profile-title {
  flex: 1;
  min-width: 0;
}

.profile-avatar {
  flex: none;
  width: 52px;
  height: 52px;
  overflow: hidden;
  border-radius: 50%;
  background: var(--el-fill-color);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.profile-avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 20px;
  color: var(--el-text-color-secondary);
}

.profile-name {
  margin: 0;
  font-size: 15px;
  line-height: 1.4;
}

/* 队伍徽标：以队色渐变的小药丸（与全局 .icon-tile 配色同式），替换此前未生效的 .room-team */
.profile-team {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 16px;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--tb-color) 72%, #fff), var(--tb-color));
  box-shadow: 0 3px 8px -3px color-mix(in srgb, var(--tb-color) 55%, transparent);
}

/* 升格入口：20px 单字徽章。渐变亮底 = 还没升格，浅底描边 = 已设好队伍，绿勾 = 她已正式升格 */
.promote-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  background: radial-gradient(72% 72% at 32% 24%, rgba(255, 255, 255, 0.55), transparent 62%), var(--gradient-brand);
  box-shadow: 0 2px 7px -3px rgba(var(--brand-rgb), 0.7);
  cursor: pointer;
  /* 光晕走 filter：box-shadow 要留给 hover 的描边，同一属性挂两条动画会互相覆盖 */
  animation: promote-breathe 3.4s ease-in-out infinite;
  transition:
    box-shadow 0.22s ease,
    transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);

  &:hover {
    box-shadow:
      0 3px 10px -3px rgba(var(--brand-rgb), 0.7),
      0 0 0 3px rgba(var(--brand-rgb), 0.13);
    transform: scale(1.1);
  }

  &:active {
    transform: scale(0.94);
  }

  /* 已设好队伍（含她已正式升格）：收成浅底描边，不再抢眼 */
  &.is-revert {
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    box-shadow: inset 0 0 0 1px var(--el-border-color);
    filter: none;
    animation: none;

    &:hover {
      color: var(--el-text-color-primary);
      background: var(--el-fill-color);
    }
  }

  /* 她已正式升格：换完成色 + 勾，点击直接清本地记录而不再开弹窗 */
  &.is-fulfilled {
    color: var(--el-color-success);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--el-color-success) 40%, transparent);
  }
}

@keyframes promote-breathe {
  0%,
  100% {
    filter: drop-shadow(0 0 2px rgba(var(--brand-rgb), 0.12));
  }

  50% {
    filter: drop-shadow(0 0 5px rgba(var(--brand-rgb), 0.42));
  }
}

@media (prefers-reduced-motion: reduce) {
  .promote-btn {
    animation: none;
  }

  .promote-btn:hover {
    transform: none;
  }
}

.profile-info {
  margin: 12px 0 0;
}

.profile-info-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.8;

  dt {
    flex: none;
    color: var(--el-text-color-placeholder);
  }

  dd {
    min-width: 0;
    margin: 0;
    color: var(--el-text-color-regular);
  }
}

/* 关注区：一枚主开关 + 一行状态说明。本机不是第二个开关，只在状态行里出现 */
.profile-follow {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}

.follow-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.follow-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--el-text-color-secondary);
  cursor: default;
}

.follow-label-ico {
  flex: none;
  color: var(--el-text-color-placeholder);

  &.is-on {
    color: var(--brand-primary);
  }
}

/* 主开关按动作着色：未关注 = 品牌渐变（告诉我可以关注）；
 * 已关注 = 中性胶囊，hover 转危险色（下一步是取关） */
.follow-btn {
  height: 24px;
  padding: 0 12px;
  border: none;
  font-size: 12px;
  font-weight: 600;

  &.is-add {
    color: #fff;
    background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
    box-shadow: 0 4px 10px -4px color-mix(in srgb, var(--brand-primary) 55%, transparent);

    &:hover {
      filter: brightness(1.06);
    }
  }

  &.is-remove {
    color: var(--el-text-color-secondary);
    background: color-mix(in srgb, var(--el-text-color-secondary) 10%, transparent);

    &:hover {
      color: var(--el-color-danger);
      background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
    }
  }
}

/* 状态说明：一句随状态变化的话，承担原本那段长解释的全部工作 */
.follow-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--el-text-color-placeholder);
}

.follow-state {
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.follow-dot {
  margin: 0 2px;
}

/* 次级操作（仅在本机关注 / 移出本机）：文字按钮，不与主开关抢视觉 */
.follow-text-btn {
  padding: 0;
  border: none;
  font: inherit;
  color: var(--el-text-color-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
  background: none;
  cursor: pointer;

  &:hover {
    color: var(--el-color-danger);
  }

  &:disabled {
    color: var(--el-text-color-placeholder);
    cursor: default;
  }
}
/* 直播状态卡：可点进入直播；cover 统一 16:9 弱化占位 */
.profile-live {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  font: inherit;
  text-align: left;
  background: var(--el-fill-color-light);
  cursor: pointer;

  &:hover {
    background: var(--el-fill-color);

    .profile-live-action {
      color: var(--color-lives);
    }
  }
}

.profile-live-cover {
  flex: none;
  width: 72px;
  height: 40px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--el-fill-color);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.profile-live-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-lives) 70%, #fff), var(--color-lives));
}

.profile-live-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}

.profile-live-badge {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  color: #fff;
  background: var(--color-lives);
}

.profile-live-title {
  max-width: 100%;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-primary);
}

.profile-live-time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}

.profile-live-action {
  flex: none;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  transition: color 0.18s ease;
}

.profile-offline {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}
</style>
