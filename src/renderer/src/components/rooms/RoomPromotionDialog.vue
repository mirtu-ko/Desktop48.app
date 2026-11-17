<script setup lang="ts">
// 预备生「本地升格」弹窗：选一支有官方队徽的队伍，只落当前登录账号的本地记录。
// 队伍目录、升格预演与页脚都在这里；资料卡只负责按钮三态与开关。
import { isTraineeTeam } from '@common/member-team-promotion'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { MemberTeamPromotionError, useMemberTeamPromotionStore } from '@renderer/stores/member-team-promotion'
import { useMemberTreeStore } from '@renderer/stores/member-tree'
import { teamOptionsOfMember } from '@renderer/utils/member-team-promotion'
import Tools from '@renderer/utils/tools'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  userId: number
  nickname: string
  /** 展示用头像（资料卡已按名录兜底过） */
  avatar: string
  /** 服务端队伍：与资料卡同一判据，仍是预备生时本地记录才当「调整队伍」 */
  teamName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const { promotionOf, setPromotion, clearPromotion } = useMemberTeamPromotionStore()
const promotion = computed(() => promotionOf(props.userId))
/** 已有记录且她仍是预备生 = 调整；她已正式升格时资料卡的按钮直接清记录，不会开这里 */
const adjusting = computed(() => !!promotion.value && isTraineeTeam(props.teamName))

const { memberTree, loadTree } = useMemberTreeStore()
/** 可选队伍：按成员在成员树里定位团体，只取有官方队徽的队伍 */
const teamOptions = computed(() => teamOptionsOfMember(memberTree.value, props.userId))

const pickedTeam = ref('')
const busy = ref(false)
const treeLoading = ref(false)
const treeError = ref(false)

const pickedOption = computed(() => teamOptions.value.find(team => team.teamName === pickedTeam.value) ?? null)
/** 选中队伍后整段预演区域染上队色 */
const stageStyle = computed(() => Tools.colorVarStyle('--tc', pickedOption.value?.teamColor || ''))

const title = computed(() => adjusting.value ? '调整队伍' : '让我给你升格')
const lead = computed(() => adjusting.value
  ? ['换一支队伍，或取消升格。', '改动只留在你的账号里。']
  : ['把她从「预备生」送进升格的队伍，', '这份偏爱只留在你的账号里。'])
const confirmLabel = computed(() => adjusting.value ? '保存' : '为她升格')
const emptyText = computed(() => {
  if (treeLoading.value)
    return '正在读取队伍资料…'
  if (treeError.value)
    return '队伍资料未同步，请关闭后重试'
  return memberTree.value.length
    ? '该团体暂无带队徽的队伍'
    : '成员资料未同步，请先在设置页同步成员库'
})

/** 每次打开都重取一次队伍目录（store 自带缓存）：成员库可能刚同步，队伍与队徽以这份为准 */
watch(visible, async (open) => {
  if (!open)
    return
  pickedTeam.value = promotion.value?.teamName || ''
  treeLoading.value = true
  treeError.value = false
  try {
    await loadTree()
  }
  catch {
    treeError.value = true
  }
  finally {
    treeLoading.value = false
  }
})

/** radiogroup 的 roving tabindex：方向键切换选中项并接管焦点 */
const teamButtons: HTMLElement[] = []
function setTeamButton(el: unknown, index: number) {
  if (el instanceof HTMLElement)
    teamButtons[index] = el
}

function onTeamKeydown(event: KeyboardEvent) {
  const options = teamOptions.value
  if (!options.length)
    return
  const current = options.findIndex(team => team.teamName === pickedTeam.value)
  let next = current
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = current < 0 ? 0 : (current + 1) % options.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = options.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  pickedTeam.value = options[next].teamName
  teamButtons[next]?.focus()
}

/** 确认升格：只落本机，队伍色取自队伍目录 */
async function confirmPromotion() {
  const option = pickedOption.value
  if (!option)
    return
  busy.value = true
  try {
    await setPromotion({ userId: props.userId, teamName: option.teamName, teamColor: option.teamColor })
    ElMessage.success(`已把 ${props.nickname} 升格到 ${Tools.shortTeamName(option.teamName)}（仅当前账号可见）`)
    visible.value = false
  }
  catch (error) {
    console.error('[RoomPromotionDialog]升格设置失败:', error)
    ElMessage.error(error instanceof MemberTeamPromotionError ? error.message : '设置失败，请稍后重试')
  }
  finally {
    busy.value = false
  }
}

/** 取消升格：清掉本机记录，展示回到服务端队伍 */
async function cancelPromotion() {
  busy.value = true
  try {
    await clearPromotion(props.userId)
    ElMessage.success(`已取消升格，${props.nickname} 回到官方队伍`)
    visible.value = false
  }
  catch (error) {
    console.error('[RoomPromotionDialog]取消升格失败:', error)
    ElMessage.error('取消失败，请稍后重试')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <!-- 预备生升格弹窗：只列有官方队徽的队伍，只落本机记录 -->
  <el-dialog
    v-model="visible"
    class="promote-dialog"
    modal-class="promote-overlay"
    align-center
    append-to-body
    :show-close="false"
  >
    <template #header>
      <header class="promote-head">
        <span class="promote-kicker">
          <MediaIcon name="heartFilled" :size="11" />
          粉丝的心意
        </span>
        <h3 class="promote-title">
          {{ title }}
        </h3>
        <p class="promote-lead">
          {{ lead[0] }}<br>{{ lead[1] }}
        </p>
      </header>
    </template>

    <div class="promote-body">
      <!-- 升格预演：现在的她 → 你选的队伍；选中后才亮起队色 -->
      <div class="promote-stage" :class="{ 'has-team': !!pickedOption }" :style="stageStyle">
        <div class="stage-slot">
          <span class="stage-avatar">
            <img
              v-if="avatar"
              :src="avatar"
              :alt="nickname"
              referrerpolicy="no-referrer"
            >
            <span v-else class="stage-avatar-fallback">{{ nickname.slice(0, 1) }}</span>
          </span>
          <span class="stage-name ellipsis">{{ nickname }}</span>
          <span class="stage-tag">预备生</span>
        </div>

        <span class="stage-link" aria-hidden="true">
          <i class="stage-link-line" />
          <MediaIcon name="heartFilled" :size="14" />
          <i class="stage-link-line" />
        </span>

        <div class="stage-slot">
          <span class="stage-badge" :class="{ 'is-empty': !pickedOption }">
            <img
              v-if="pickedOption?.teamBadge"
              :src="pickedOption.teamBadge"
              :alt="pickedOption.teamName"
              referrerpolicy="no-referrer"
            >
            <span v-else-if="pickedOption" class="stage-badge-fallback">
              {{ Tools.shortTeamName(pickedOption.teamName) }}
            </span>
            <span v-else class="stage-badge-fallback">?</span>
          </span>
          <span class="stage-name ellipsis">
            {{ pickedOption ? pickedOption.teamName : '待选择' }}
          </span>
          <span class="stage-tag is-team">{{ pickedOption ? '升格后' : '你的选择' }}</span>
        </div>
      </div>

      <!-- 队伍卡：队标 + 全称，选中后整卡染队色 -->
      <div class="promote-teams" role="radiogroup" aria-label="选择升格队伍" @keydown="onTeamKeydown">
        <button
          v-for="(team, index) in teamOptions"
          :key="team.teamName"
          :ref="el => setTeamButton(el, index)"
          type="button"
          role="radio"
          class="team-card"
          :class="{ 'is-active': team.teamName === pickedTeam }"
          :aria-checked="team.teamName === pickedTeam"
          :tabindex="team.teamName === pickedTeam || (!pickedTeam && index === 0) ? 0 : -1"
          :style="{
            ...Tools.colorVarStyle('--tc', team.teamColor),
            '--tc-ink': Tools.readableInk(Tools.toHex(team.teamColor)),
            '--i': index,
          }"
          @click="pickedTeam = team.teamName"
        >
          <span class="team-card-badge">
            <img
              v-if="team.teamBadge"
              :src="team.teamBadge"
              :alt="team.teamName"
              referrerpolicy="no-referrer"
            >
            <span v-else class="team-card-badge-fallback">{{ Tools.shortTeamName(team.teamName) }}</span>
          </span>
          <span class="team-card-text">
            <span class="team-card-name ellipsis">{{ team.teamName }}</span>
            <span class="team-card-sub ellipsis">{{ team.groupName }}</span>
          </span>
          <span class="team-card-check">
            <MediaIcon name="check" :size="12" />
          </span>
        </button>
      </div>

      <p v-if="treeLoading || treeError || teamOptions.length === 0" class="promote-empty">
        {{ emptyText }}
      </p>
    </div>

    <template #footer>
      <div class="promote-foot">
        <p class="promote-note">
          仅当前口袋账号可见，退出登录或切换账号后不再生效，也不会改动她的口袋资料。
        </p>
        <div class="promote-actions">
          <el-button
            v-if="adjusting"
            text
            :loading="busy"
            @click="cancelPromotion"
          >
            取消升格
          </el-button>
          <el-button text @click="visible = false">
            先不了
          </el-button>
          <el-button
            type="primary"
            :loading="busy"
            :disabled="!pickedTeam"
            @click="confirmPromotion"
          >
            <MediaIcon v-if="!busy" class="promote-heart" name="heartFilled" :size="12" />
            {{ confirmLabel }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
/* ===== 升格弹窗：一封写给她的情书（队标 + 全称 + 队色） =====
 * 外壳（底色 / 圆角 / 蒙版 / EP 内部盒 padding）在 app.scss：根节点在 Teleport 里，scoped 够不到 */
.promote-head {
  text-align: center;
}

.promote-kicker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--brand-primary);
  background: rgba(var(--brand-rgb), 0.1);
}

.promote-title {
  margin: 10px 0 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--el-text-color-primary);
}

.promote-lead {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.promote-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

/* 升格预演：她 → 你选的队伍；没有选择前保持中性灰，选中后整段染队色 */
.promote-stage {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 18px;
  background: var(--el-fill-color-lighter);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  transition:
    background 0.3s ease,
    box-shadow 0.3s ease;
  /* backwards 只让 delay 期间套用起始帧：both 会一直压着 transform，hover 位移就失效了 */
  animation: promote-rise 0.3s ease backwards;

  &.has-team {
    /* 两端都带基底：透明渐变会把 --el-fill-color-lighter 整个换掉，暗色下层级会反过来 */
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--tc) 16%, var(--el-fill-color-lighter)),
      color-mix(in srgb, var(--tc) 4%, var(--el-fill-color-lighter))
    );
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--tc) 32%, transparent),
      0 10px 24px -20px color-mix(in srgb, var(--tc) 65%, transparent);

    .stage-link {
      color: color-mix(in srgb, var(--tc) 65%, transparent);
    }
  }
}

.stage-slot {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.stage-avatar,
.stage-badge {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 46px;
  height: 46px;
  overflow: hidden;
  border-radius: 50%;
  background: var(--el-bg-color);
  box-shadow:
    0 0 0 1px var(--el-border-color-lighter),
    0 6px 14px -10px rgba(var(--shadow-rgb), 0.5);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

/* 队标是方形徽章：圆角方框，等比缩入（与成员页分区标题的徽章盒子同款取法） */
.stage-badge {
  border-radius: 14px;

  img {
    box-sizing: border-box;
    width: auto;
    height: auto;
    max-width: calc(100% - 8px);
    max-height: calc(100% - 8px);
    object-fit: contain;
  }

  &.is-empty {
    border: 1px dashed var(--el-border-color);
    background: transparent;
    box-shadow: none;
  }
}

.stage-avatar-fallback,
.stage-badge-fallback {
  font-size: 12px;
  font-weight: 700;
  color: var(--el-text-color-placeholder);
}

.stage-badge-fallback {
  color: color-mix(in srgb, var(--tc) 78%, var(--el-text-color-primary));
}

.stage-name {
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stage-tag {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color);

  &.is-team {
    color: color-mix(in srgb, var(--tc) 72%, var(--el-text-color-primary));
    background: color-mix(in srgb, var(--tc) 12%, transparent);
  }
}

.stage-link {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  width: 58px;
  color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
  transition: color 0.3s ease;
}

.stage-link-line {
  flex: 1;
  height: 0;
  border-top: 1px dashed currentColor;
}

/* 队伍卡：队标 + 全称 + 团体副行，选中后描边与底色一起染队色 */
.promote-teams {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.team-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 9px 10px;
  border: none;
  border-radius: 16px;
  font: inherit;
  text-align: left;
  background: var(--el-fill-color-lighter);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  cursor: pointer;
  transition:
    transform 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
  animation: promote-rise 0.3s ease backwards;
  animation-delay: calc(var(--i, 0) * 45ms);

  &:hover {
    transform: translateY(-2px);
    background: color-mix(in srgb, var(--tc) 12%, var(--el-fill-color-lighter));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tc) 38%, transparent);
  }

  &.is-active {
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--tc) 20%, var(--el-fill-color-lighter)),
      color-mix(in srgb, var(--tc) 6%, var(--el-fill-color-lighter))
    );
    box-shadow:
      inset 0 0 0 1.5px color-mix(in srgb, var(--tc) 60%, transparent),
      0 12px 22px -18px color-mix(in srgb, var(--tc) 75%, transparent);
  }

  &.is-active .team-card-check {
    opacity: 1;
    transform: scale(1);
  }
}

.team-card-badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  overflow: hidden;
  border-radius: 10px;
  background: color-mix(in srgb, var(--tc) 10%, var(--el-bg-color));

  img {
    display: block;
    box-sizing: border-box;
    width: auto;
    height: auto;
    max-width: calc(100% - 8px);
    max-height: calc(100% - 8px);
    object-fit: contain;
  }
}

.team-card-badge-fallback {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--tc) 80%, var(--el-text-color-primary));
}

.team-card-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.team-card-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.team-card-sub {
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}

/* 选中勾：队色印章，勾色按队色明度取自 readableInk，浅色队伍上也读得清 */
.team-card-check {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--tc-ink, #fff);
  background: var(--tc);
  box-shadow:
    0 0 0 2px var(--el-bg-color),
    0 6px 12px -6px rgba(var(--shadow-rgb), 0.55);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.promote-empty {
  margin: 0;
  font-size: 12px;
  text-align: center;
  color: var(--el-text-color-secondary);
}

.promote-foot {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.promote-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
  color: var(--el-text-color-placeholder);
}

.promote-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;

  :deep(.el-button) {
    margin-left: 0;
  }
}

.promote-heart {
  margin-right: 5px;
}

@keyframes promote-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .promote-stage,
  .team-card {
    animation: none;
  }

  .team-card:hover {
    transform: none;
  }
}
</style>
