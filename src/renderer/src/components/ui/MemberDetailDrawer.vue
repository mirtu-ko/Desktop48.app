<script setup lang="ts">
import type { MemberDetail } from '@renderer/utils/member-merge'
import { Film, Hide, Link, User, View } from '@element-plus/icons-vue'
import Constants from '@renderer/utils/constants'
import Tools from '@renderer/utils/tools'
import { computed } from 'vue'
import { useRouter } from 'vue-router'

/**
 * 成员详情抽屉（两个数据源合并后的唯一详情页）：
 * starInfo 提供头像/写真/微博/状态，allmembers 补齐排名/经历/口头禅/所属公司。
 */
const props = defineProps<{ member: MemberDetail | null, blocked?: boolean }>()
const emit = defineEmits<{ close: [], toggleBlock: [member: MemberDetail] }>()

const router = useRouter()

/** 成员状态元信息：收口于 Constants.MemberStatusMeta（与成员页分区共用） */
const STATUS_META = Constants.MemberStatusMeta

const statusMeta = computed(() =>
  STATUS_META[props.member?.status ?? 1] || STATUS_META[1],
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
    { label: '总选排名', value: member.ranking ? `第 ${member.ranking} 名` : '' },
  ].filter(item => item.value)
})

/** 经历：接口用 <br> 分行，按 <br>/<br/> 拆成行数组渲染（避免 v-html 引入 XSS） */
const experienceLines = computed(() =>
  (props.member?.experience || '').split(/<br\s*\/?>/i).map(line => line.trim()).filter(Boolean),
)

/** 官网独有的补充成员没有口袋 userId：屏蔽与回放入口都不可用 */
const actionable = computed(() => typeof props.member?.userId === 'number')

/** 关闭抽屉（点击遮罩 / ESC / 关闭按钮） */
function onVisibilityChange(value: boolean) {
  if (!value)
    emit('close')
}

/** 点击卡片「看 TA 的回放」：跳转直播页回放 tab 并按该成员预置筛选。
 *  跳转语义由路由 query 承载（原 EventBus 'open-member-playbacks' 事件已移除）：
 *  /lives?tab=playback&member=<userId>，Lives 页解析后切 tab + 应用筛选 */
function openPlaybacks() {
  if (!props.member?.userId)
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
      <!-- 头部：头像 + 姓名/队伍徽章 + 状态徽章 + 昵称 + 微博 -->
      <div class="hero">
        <el-image class="avatar" :src="member.avatar" fit="cover">
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
            <span
              v-if="member.teamName"
              class="team-badge"
              :style="member.teamColor ? { '--tb-color': `#${member.teamColor}` } : undefined"
            >
              {{ Tools.shortTeamName(member.teamName) }}
            </span>
          </div>
          <div class="tags">
            <el-tag v-if="blocked" type="danger" size="small" effect="light">
              已屏蔽
            </el-tag>
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

      <div v-if="member.catchPhrase" class="block">
        <p class="label">
          Catch Phrase
        </p>
        <p class="value">
          {{ member.catchPhrase }}
        </p>
      </div>

      <div v-if="experienceLines.length" class="block">
        <p class="label">
          经历
        </p>
        <ul class="experience-list">
          <li v-for="(line, index) in experienceLines" :key="index">
            {{ line }}
          </li>
        </ul>
      </div>

      <div v-if="member.company" class="block">
        <p class="label">
          所属公司
        </p>
        <p class="value">
          {{ member.company }}
        </p>
      </div>

      <!-- 写真图集：点击放大预览 -->
      <div v-if="member.photos.length" class="block">
        <p class="label">
          写真
        </p>
        <div class="photos">
          <el-image
            v-for="(photo, index) in member.photos"
            :key="photo"
            class="photo"
            :src="photo"
            :preview-src-list="member.photos"
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

      <!-- 回放直达 + 屏蔽操作（官网独有的补充成员没有 userId，两者都不展示） -->
      <div v-if="actionable" class="actions">
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

.group-chip {
  padding: 2px 10px;
  border-radius: 999px;
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
    min-width: 0;
    color: var(--el-text-color-primary);
  }
}

.block {
  .label {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-regular);
  }

  .value {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--el-text-color-primary);
    white-space: pre-line;
  }
}

/* 经历：无序列表小点 */
.experience-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-primary);

  li {
    margin: 2px 0;
  }
}

.photos {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, 1fr);

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
