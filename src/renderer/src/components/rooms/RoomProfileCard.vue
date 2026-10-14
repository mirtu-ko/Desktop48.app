<script setup lang="ts">
import type { LiveListItem } from '@renderer/services/api-types'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { useFloatPlayersStore } from '@renderer/stores/float-players'
import { useMemberDirectoryStore } from '@renderer/stores/member-directory'
import Tools from '@renderer/utils/tools'
import dayjs from 'dayjs'
import { computed, ref, watch } from 'vue'

/** 左栏房间条目（PocketRoom 的最小子集；live 为该成员当前在播直播） */
const props = defineProps<{
  userId: number
  nickname: string
  avatar: string
  teamName: string
  teamColor: string
  live: LiveListItem | null
}>()

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
const cardTeamName = computed(() => member.value?.teamName || props.teamName)
const cardTeamColor = computed(() => member.value?.teamColor || props.teamColor)

/** 生日行：有生日就带星座，无生日整行隐藏 */
const birthdayLine = computed(() => {
  if (!member.value?.birthday)
    return ''
  return member.value.constellation
    ? `${member.value.birthday}（${member.value.constellation}）`
    : member.value.birthday
})

/** 成员状态文案：1 在团 2 暂休 3 退团 */
const statusText = computed(() => {
  const map: Record<number, string> = { 1: '在团', 2: '暂休', 3: '退团' }
  return map[member.value?.status ?? 1] ?? ''
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
        <div class="profile-tags">
          <span
            v-if="cardTeamName"
            class="room-team"
            :style="Tools.colorVarStyle('--tb-color', cardTeamColor)"
          >{{ Tools.shortTeamName(cardTeamName) }}</span>
          <span v-if="statusText" class="profile-status">{{ statusText }}</span>
        </div>
      </div>
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
    </dl>

    <!-- 直播状态：在播显示封面 + 标题 + 开播时间，一键进入直播 -->
    <button v-if="live" type="button" class="profile-live" @click="enterLive">
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
    <p v-else class="profile-offline">
      未开播
    </p>
  </section>
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

.profile-title {
  min-width: 0;
}

.profile-name {
  margin: 0;
  font-size: 15px;
  line-height: 1.4;
}

.profile-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.profile-status {
  font-size: 11px;
  color: var(--el-text-color-secondary);
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

/* 直播状态卡：可点进入直播；cover 统一 16:9 弱化占位 */
.profile-live {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-top: 12px;
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
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
</style>
