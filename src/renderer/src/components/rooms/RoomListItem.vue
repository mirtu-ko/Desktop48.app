<script lang="ts">
import type { PocketRoom } from '@renderer/composables/use-pocket-rooms'
</script>

<script setup lang="ts">
import { Close, StarFilled } from '@element-plus/icons-vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import Tools from '@renderer/utils/tools'

/**
 * 左列条目：房间本体 + 页面已派生好的展示字段。
 *
 * 未读计数、房间关闭态、提示语都依赖页面与各 store 的联动，放在组件里会把它变成
 * 「小号页面」；这里只接收算好的结果，组件本身不读任何 store。
 */
export interface RoomListEntry extends PocketRoom {
  pinned: boolean
  displayTeam: { teamName: string, teamColor: string }
  /** 未读角标文案；空串表示不展示 */
  unreadText: string
  /** 悬浮说明（进房 / 双击回底 / 右键菜单） */
  hint: string
  /** 房间已关闭 */
  closed: boolean
  /** 口袋账号侧有关注（pocket / both） */
  pocketFollowed: boolean
}

defineProps<{
  room: RoomListEntry
  /** 是否为当前选中房间 */
  active: boolean
}>()

const emit = defineEmits<{
  select: []
  dblclick: [event: MouseEvent]
  contextmenu: [event: MouseEvent]
  closeTemp: []
}>()
</script>

<template>
  <div
    class="room-wrap"
    :class="{ 'is-temp': room.temporary }"
    @dblclick="emit('dblclick', $event)"
    @contextmenu="emit('contextmenu', $event)"
  >
    <button
      type="button"
      class="room-item"
      :class="{ 'is-active': active, 'is-live': !!room.live }"
      :title="room.hint"
      @click="emit('select')"
    >
      <span class="room-avatar">
        <img v-if="room.avatar" :src="room.avatar" :alt="room.nickname" referrerpolicy="no-referrer">
        <span v-else class="room-avatar-fallback">{{ room.nickname.slice(0, 1) }}</span>
        <!-- 开播状态：头像外沿呼吸光环（见 .room-live-badge），不占头像角落 -->
        <span v-if="room.live" class="room-live-badge" aria-label="直播中" />
        <!-- 开播状态：头像下沿白色跃动光柱（见 .room-eq），压在玫红晕染上 -->
        <span v-if="room.live" class="room-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <!-- 未读数字角标（主进程未读检测 → stores/pocket-unread 镜像）：右上角保持未读红点；开播呼吸光环只绕头像外周，不抢这个角 -->
        <span
          v-if="room.unreadText"
          class="unread-badge room-unread"
        >{{ room.unreadText }}</span>
      </span>
      <span class="room-meta">
        <span class="room-name-row">
          <span class="room-name ellipsis">{{ room.nickname }}</span>
          <!-- 置顶标记紧跟名字：名字不撑满整行（见 .room-name），标记才贴得住，
             名字起始位置也不因置顶而变 -->
          <el-tooltip
            v-if="room.pinned"
            content="已置顶（右键可取消）"
            placement="top"
          >
            <MediaIcon class="room-pin-ico" name="pushpinFilled" :size="13" />
          </el-tooltip>
          <!-- 只在本地名单里（账号未关注 / 已取关）：账号关注会被同步并进本地名单，
             所以这个标记只在「本地独自撑着一个房间」时出现，不会几乎每行都挂 -->
          <span
            v-if="room.followSource === 'local'"
            class="room-local-tag"
            title="本地关注（仅本机，直播 / 回放优先展示）"
          >本地</span>
          <!-- 临时房间：本次会话临时打开的，不属于关注房间 -->
          <span v-if="room.temporary" class="room-temp-tag">临时</span>
          <span v-if="room.closed" class="room-closed-tag">已关闭</span>
        </span>

        <span v-if="room.preview" class="room-preview ellipsis">{{ room.preview }}</span>
      </span>
      <!-- 右缘竖排小标签：星星在上（口袋关注），队伍徽标在下 -->
      <span
        v-if="room.teamName || room.pocketFollowed"
        class="room-side-tags"
      >
        <el-tooltip
          v-if="room.pocketFollowed"
          content="口袋账号关注（可在设置页拉取同步）"
          placement="top"
        >
          <el-icon class="room-follow-ico"><StarFilled /></el-icon>
        </el-tooltip>
        <span
          v-if="room.displayTeam.teamName"
          class="room-team"
          :style="Tools.colorVarStyle('--tb-color', room.displayTeam.teamColor)"
        >{{ Tools.shortTeamName(room.displayTeam.teamName) }}</span>
      </span>
    </button>

    <!-- 关闭临时房间（悬浮显示；正看着时常驻，否则鼠标移开就找不到出口） -->
    <button
      v-if="room.temporary"
      type="button"
      class="room-temp-close"
      :aria-label="`关闭「${room.nickname}」的临时房间`"
      title="关闭临时房间"
      @click="emit('closeTemp')"
    >
      <el-icon :size="12">
        <Close />
      </el-icon>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use '../../assets/css/fluid' as *;

/* 条目样式随组件走。两个 %placeholder 是页面里同名骨架的副本：
   scoped 样式不跨组件生效，又不想为此把它们升级成全局类，故在此就地复制
   （改形状时请同步 pages/Rooms.vue 里的同名定义）。 */
%brand-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-rooms) 72%, #fff), var(--color-rooms));
}

%soft-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  color: var(--tag-color, var(--el-text-color-secondary));
  background: color-mix(in srgb, var(--tag-color, var(--el-text-color-secondary)) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tag-color, var(--el-text-color-secondary)) 30%, transparent);
}

.room-wrap {
  position: relative;

  /* 临时条目右侧留出关闭钮的位置，昵称与预览不会压到按钮底下 */
  &.is-temp .room-meta {
    padding-right: 18px;
  }
}

/* 关闭临时房间：压在条目右上，悬浮显示、正看着时常驻。
 * 用 visibility 而非只靠 opacity：不可见时同时屏蔽命中，不留点得到的隐形按钮 */
.room-temp-close {
  position: absolute;
  top: 7px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.18s ease,
    visibility 0s linear 0.18s,
    color 0.15s ease,
    background-color 0.15s ease;

  .room-wrap:hover &,
  .room-wrap:focus-within &,
  .room-item.is-active ~ & {
    opacity: 1;
    visibility: visible;
    transition-delay: 0s;
  }

  &:hover {
    color: #fff;
    background: var(--el-color-danger);
  }
}

.room-item {
  display: flex;
  align-items: center;
  gap: fluid(8px, 10px);
  width: 100%;
  padding: fluid(7px, 9px) 8px;
  border: none;
  border-radius: 12px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s ease;

  &:hover {
    background: var(--el-fill-color-light);
  }

  &.is-active {
    background: color-mix(in srgb, var(--color-rooms) 14%, transparent);

    .room-name {
      color: var(--color-rooms);
      font-weight: 600;
    }
  }
}

.room-avatar {
  position: relative;
  flex: none;
  width: fluid(36px, 42px);
  height: fluid(36px, 42px);

  img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    background: var(--el-fill-color-light);
  }
}

.room-avatar-fallback {
  @extend %brand-avatar;

  width: 100%;
  height: 100%;
  font-size: 16px;
}

/* 开播状态：头像外沿一圈呼吸光环，不占头像角落，未读角标照旧贴右上角。
 * 只动 opacity / transform（合成器线程）：环本体呼吸，::after 外扩柔光脉冲。
 * transform / opacity 动画自身即提层，不再常驻 will-change —— 多成员同时开播时
 * 每条都预留合成层没有收益，窗口隐藏时也无法回收 */
.room-live-badge {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid var(--color-lives);
  pointer-events: none;
  animation: room-live-breathe 2.4s ease-in-out infinite;

  &::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    box-shadow: 0 0 6px 2px color-mix(in srgb, var(--color-lives) 45%, transparent);
    animation: room-live-pulse 2.4s ease-in-out infinite;
  }
}

@keyframes room-live-breathe {
  0%,
  100% {
    opacity: 0.8;
  }

  50% {
    opacity: 1;
  }
}

@keyframes room-live-pulse {
  0%,
  100% {
    transform: scale(0.9);
    opacity: 0.9;
  }

  50% {
    transform: scale(1.25);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .room-live-badge {
    animation: none;

    &::after {
      display: none;
    }
  }
}

/* 开播状态：头像下半部分的玫红晕染，上浅下深。
 * 只覆盖约下 50%，人像上半部保持原样；底部浓度足以托住白色光柱。
 * 静态渐变（不提层、不参与动画），随头像圆形裁切，边缘不会越界 */
.room-item.is-live .room-avatar::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(85% 55% at 50% 96%, color-mix(in srgb, var(--color-lives) 30%, transparent) 0%, transparent 78%),
    linear-gradient(
      to bottom,
      transparent 48%,
      color-mix(in srgb, var(--color-lives) 12%, transparent) 62%,
      color-mix(in srgb, var(--color-lives) 38%, transparent) 82%,
      color-mix(in srgb, var(--color-lives) 66%, transparent) 100%
    );
  pointer-events: none;
}

/* 开播状态：压在晕染上的三根白色跃动光柱。
 * 柱身顶端渐隐、外圈一点柔光，读作「光」而不是硬白实体块；
 * 起伏全靠 scaleY（transform 合成，不触发重排），三条各自不同周期，
 * 不与外圈光环的 2.4s 同步，避免整体机械齐动 */
.room-eq {
  position: absolute;
  bottom: 3px;
  left: 50%;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 14px;
  transform: translateX(-50%);
  pointer-events: none;
  /* 晕染是头像 ::after（树序更靠后），光柱需显式提层压在其上 */
  z-index: 1;

  i {
    display: block;
    width: 3px;
    /* 固定满高度，起伏全靠 scaleY */
    height: 14px;
    border-radius: 2px;
    background: linear-gradient(
      to top,
      rgba(255, 255, 255, 0.98) 0%,
      rgba(255, 255, 255, 0.82) 60%,
      rgba(255, 255, 255, 0) 100%
    );
    box-shadow: 0 0 3px 0 rgba(255, 255, 255, 0.38);
    transform-origin: bottom;
    animation: room-eq-bounce 1.1s ease-in-out infinite;

    &:nth-child(1) {
      animation-duration: 1.02s;
      animation-delay: -0.14s;
    }

    &:nth-child(2) {
      animation-duration: 1.34s;
      animation-delay: -0.67s;
    }

    &:nth-child(3) {
      animation-duration: 1.16s;
      animation-delay: -0.39s;
    }
  }
}

/* 非对称起伏 + 三根条各自不同周期 */
@keyframes room-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.3);
  }

  18% {
    transform: scaleY(0.9);
  }

  38% {
    transform: scaleY(0.48);
  }

  62% {
    transform: scaleY(1);
  }

  82% {
    transform: scaleY(0.55);
  }
}

@media (prefers-reduced-motion: reduce) {
  .room-eq i {
    animation: none;
    /* 静态不等高，不动也仍是电平指示的样子 */
    transform: scaleY(0.5);

    &:nth-child(2) {
      transform: scaleY(0.8);
    }

    &:nth-child(3) {
      transform: scaleY(0.62);
    }
  }
}

/* 页面不可见（窗口最小化 / 被遮挡）时暂停整页直播特效：
 * animation-play-state 在合成器线程生效，主线程零成本，恢复可见后无缝续播 */

.room-unread {
  position: absolute;
  top: -5px;
  right: -5px;
  box-shadow: 0 0 0 2px var(--el-bg-color);
}

.room-meta {
  flex: 1;
  min-width: 0;
}

.room-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* 名字不撑满整行：置顶图钉要贴得住名字，撑满会把标记推到行尾。
 * 过长时照常收缩截断（min-width: 0 + ellipsis），不挤掉右侧标记 */
.room-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

/* 名字行里的状态标签仍靠右：名字不再撑满后，靠 auto 外边距占住这段空隙 */
.room-name-row .room-temp-tag,
.room-name-row .room-closed-tag {
  margin-left: auto;
}

/* 置顶标记：图钉（实心壳，手写 SVG 见 MediaIcon），紧跟名字。
 * 13px 是下限——11px 时针脚缩到不足一个物理像素，糊成小圆点 */
.room-pin-ico {
  flex: none;
  color: var(--color-rooms);
}

/* 队伍徽标 / 临时标记：右栏头部与本组件共用同一外观。
   那两份留在 pages/Rooms.vue（scoped 不跨组件），改形状时两处一起改。 */
.room-team {
  @extend %soft-tag;

  --tag-color: var(--tb-color, var(--brand-primary));

  /* 队伍色只做淡底不加描边：它是身份标识，不像下面两个是状态提示 */
  box-shadow: none;
}

/* 「本地」关注标记：只在仅本地关注的房间出现——账号关注会被同步并进本地名单（both），
 * 用中性色与「临时 / 已关闭」同规格，表达「这个房间只靠本机记录留着」 */
.room-local-tag {
  @extend %soft-tag;

  --tag-color: var(--el-text-color-secondary);
}

/* 「临时」标记（左列条目与右栏头部共用）：换房间主题青 + 描边，
 * 一眼与「关注房间」区分开——它不会在下次进页面时还在 */
.room-temp-tag {
  @extend %soft-tag;

  --tag-color: var(--color-rooms);
}

/* 「已关闭」标记：与临时标签同规格，用中性色表达不可用，不抢直播 / 未读的强调 */
.room-closed-tag {
  @extend %soft-tag;

  --tag-color: var(--el-text-color-secondary);
}

/* 条目右缘竖排小标签列：口袋关注星标在上、队伍徽标在下。
 * 固定列宽：队伍徽标宽窄不一时，各行星星仍横向对齐（过长的队名截断省略） */
.room-side-tags {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  /* 星标 11 + 队伍徽标 16 + 间隔 = 29，低于头像 42，两条都在也不撑高行 */
  gap: 2px;
  width: 38px;
  margin-left: 6px;
}

.room-side-tags .room-team {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 口袋关注星标：11px 品牌色（语义：已关注），详情看 tooltip 与资料卡 */
.room-follow-ico {
  flex: none;
  font-size: 11px;
  color: var(--brand-primary);
  opacity: 0.8;
}

/* 左列预览：频道最新一条消息（批量接口一次拉全，选中房间轮询到时本地即时补） */

.room-preview {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--el-text-color-placeholder);
}

/* 窄窗收窄条目水平内边距：与页面其它横向留白一起收，垂直分量归密度档 */
@media (max-width: 960px) {
  .room-item {
    padding-inline: 6px;
  }
}
</style>
