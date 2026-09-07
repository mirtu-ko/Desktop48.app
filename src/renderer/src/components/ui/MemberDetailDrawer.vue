<script setup lang="ts">
import { Film, Hide, Link, User, View } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Constants from '../../utils/constants'
import Tools from '../../utils/tools'

/** 成员详情（树节点为 starInfo 全量字段的 spread，这里声明展示用到的字段） */
export interface MemberDetail {
  userId: number
  realName: string
  nickname: string
  avatar: string
  teamName: string
  teamColor: string
  /** 1 在团 2 暂休 3 退团 */
  status: number
  birthday: string
  constellation: string
  bloodType: string
  height: string
  birthplace: string
  joinTime: string
  periodName: string
  specialty: string
  hobbies: string
  wbName: string
  wbUid: string
  fullPhoto1?: string
  fullPhoto2?: string
  fullPhoto3?: string
  fullPhoto4?: string
  [key: string]: unknown
}

const props = defineProps<{ member: MemberDetail | null, blocked?: boolean }>()
const emit = defineEmits<{ close: [], toggleBlock: [member: MemberDetail] }>()

const router = useRouter()

/** 成员状态元信息：收口于 Constants.MemberStatusMeta（与成员页分区/回放页排序共用） */
const STATUS_META = Constants.MemberStatusMeta

const statusMeta = computed(() =>
  STATUS_META[props.member?.status ?? 1] || STATUS_META[1],
)

/** 归一化后的头像 */
const avatar = computed(() =>
  props.member?.avatar ? Tools.sourceUrl(props.member.avatar) : '',
)

/** 基础资料（空值字段不展示） */
const profileItems = computed(() => {
  const member = props.member
  if (!member)
    return []
  return [
    { label: '生日', value: member.birthday },
    { label: '星座', value: member.constellation },
    { label: '血型', value: member.bloodType },
    { label: '身高', value: member.height ? `${member.height}cm` : '' },
    { label: '出生地', value: member.birthplace },
    { label: '入团时间', value: member.joinTime },
    { label: '期数', value: member.periodName },
  ].filter(item => item.value)
})

/** 写真图集（fullPhoto1-4，空值过滤 + 相对路径归一化） */
const photos = computed(() => {
  const member = props.member
  if (!member)
    return []
  return [member.fullPhoto1, member.fullPhoto2, member.fullPhoto3, member.fullPhoto4]
    .filter(photo => !!photo)
    .map(photo => Tools.sourceUrl(photo as string))
})

/** 关闭抽屉（点击遮罩 / ESC / 关闭按钮） */
function onVisibilityChange(value: boolean) {
  if (!value)
    emit('close')
}

/** 点击卡片「看 TA 的回放」：跳转直播页回放 tab 并按该成员预置筛选。
 *  跳转语义由路由 query 承载（原 EventBus 'open-member-playbacks' 事件已移除）：
 *  /lives?tab=playback&member=<userId>，Lives 页解析后切 tab + 应用筛选 */
function openPlaybacks() {
  if (!props.member)
    return
  emit('close')
  router.push({ path: '/lives', query: { tab: 'playback', member: String(props.member.userId) } })
}
</script>

<template>
  <el-drawer
    :model-value="!!member"
    size="420px"
    @update:model-value="onVisibilityChange"
  >
    <div v-if="member" class="detail">
      <!-- 头部：头像 + 姓名/昵称 + 队伍徽章 + 状态 -->
      <div class="hero">
        <el-image class="avatar" :src="avatar" fit="cover">
          <template #placeholder>
            <div class="avatar-ph" />
          </template>
          <template #error>
            <div class="avatar-ph">
              <el-icon :size="30">
                <User />
              </el-icon>
            </div>
          </template>
        </el-image>
        <div class="head">
          <div class="name-row">
            <p class="name ellipsis" :title="member.realName">
              {{ member.realName }}
            </p>
            <div class="tags">
              <el-tag v-if="blocked" type="danger" size="small" effect="light">
                已屏蔽
              </el-tag>
              <el-tag :type="statusMeta.tag" size="small" effect="light">
                {{ statusMeta.label }}
              </el-tag>
              <span
                v-if="member.teamName"
                class="team-badge"
                :style="member.teamColor ? { '--tb-color': `#${member.teamColor}` } : undefined"
              >
                {{ Tools.shortTeamName(member.teamName) }}
              </span>
            </div>
          </div>
          <p class="nick ellipsis" :title="member.nickname">
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

      <!-- 基础资料 -->
      <div v-if="profileItems.length" class="profile-grid">
        <div v-for="item in profileItems" :key="item.label" class="cell">
          <span class="label">{{ item.label }}</span>
          <span class="value ellipsis" :title="item.value">{{ item.value }}</span>
        </div>
      </div>

      <div v-if="member.specialty" class="block">
        <p class="label">
          特长
        </p>
        <p class="value">
          {{ member.specialty }}
        </p>
      </div>

      <div v-if="member.hobbies" class="block">
        <p class="label">
          兴趣爱好
        </p>
        <p class="value">
          {{ member.hobbies }}
        </p>
      </div>

      <!-- 写真图集：点击放大预览 -->
      <div v-if="photos.length" class="block">
        <p class="label">
          写真
        </p>
        <div class="photos">
          <el-image
            v-for="(photo, index) in photos"
            :key="photo"
            class="photo"
            :src="photo"
            :preview-src-list="photos"
            :initial-index="index"
            fit="cover"
            lazy
          >
            <template #placeholder>
              <div class="photo-ph" />
            </template>
            <template #error>
              <div class="photo-ph" />
            </template>
          </el-image>
        </div>
      </div>

      <!-- 回放直达 + 屏蔽操作 -->
      <div class="actions">
        <el-button type="primary" class="playback-btn" :icon="Film" @click="openPlaybacks">
          看 TA 的回放
        </el-button>
        <el-button
          v-if="blocked"
          class="block-btn"
          :icon="View"
          @click="emit('toggleBlock', member)"
        >
          解除屏蔽
        </el-button>
        <el-button
          v-else
          type="danger"
          plain
          class="block-btn"
          :icon="Hide"
          @click="emit('toggleBlock', member)"
        >
          屏蔽
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero {
  display: flex;
  gap: 16px;
  align-items: flex-start;

  .avatar {
    flex: none;
    width: 120px;
    aspect-ratio: 3 / 4;
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }

  .avatar-ph {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--el-text-color-placeholder);
    background: var(--el-fill-color-light);
  }

  .head {
    min-width: 0;
    padding-top: 6px;
  }

  .name-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .name {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--el-text-color-primary);
  }

  .nick {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }

  .tags {
    display: flex;
    gap: 8px;
    align-items: center;
    flex: none;
  }
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

.profile-grid {
  display: grid;
  gap: 10px 14px;
  grid-template-columns: repeat(2, 1fr);
  padding: 14px;
  border-radius: 12px;
  background: var(--el-fill-color-lighter);

  .cell {
    display: flex;
    gap: 8px;
    min-width: 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .label {
    flex: none;
    color: var(--el-text-color-secondary);
  }

  .value {
    color: var(--el-text-color-primary);
  }
}

.block {
  .label {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .value {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--el-text-color-primary);
  }

  .photos {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, 1fr);
  }

  .photo,
  .photo-ph {
    width: 100%;
    aspect-ratio: 3 / 4;
    border-radius: 10px;
    overflow: hidden;
  }

  .photo {
    cursor: zoom-in;
    box-shadow: var(--shadow-sm);
  }

  .photo-ph {
    background: var(--el-fill-color-light);
  }
}

.actions {
  display: flex;
  gap: 10px;

  .el-button {
    margin-left: 0;
  }

  .playback-btn {
    flex: 1;
  }
}
</style>
