<script setup lang="ts">
import type { BirthdayEntry } from '@renderer/utils/member-birthday'
import type { MemberDetail } from '@renderer/utils/member-merge'
import { ArrowDown, User } from '@element-plus/icons-vue'
import MediaIcon from '@renderer/components/ui/MediaIcon.vue'
import { formatBirthdayCountdown, nextUpcomingBirthday, todayBirthdays } from '@renderer/utils/member-birthday'
import { memberCardKey } from '@renderer/utils/member-list'
import { computed, ref } from 'vue'

/**
 * 生日墙：成员页顶部的生日提醒横幅。
 * 折叠态一句话说清「今天谁生日 / 本月还有谁」，展开是本月的寿星日历（按日期升序）。
 * 入参是当前 tab 范围内的本月寿星（含已过完的），口径见 utils/member-birthday.ts。
 */
const props = defineProps<{
  /** 本月寿星，已按日期升序（monthBirthdays 的输出） */
  entries: BirthdayEntry[]
}>()

const emit = defineEmits<{ select: [member: MemberDetail] }>()

const expanded = ref(false)

/** 今天生日的人：横幅是否走「节庆态」由它决定 */
const todayList = computed(() => todayBirthdays(props.entries))

/** 本月最近的未到生日，没有则为 null */
const next = computed(() => nextUpcomingBirthday(props.entries))

const month = computed(() => props.entries[0]?.month ?? 0)

/** 折叠态文案：今天有人就以「今天生日 + 姓名」为主语，否则说本月总人数与下一位 */
const summary = computed(() => {
  const today = todayList.value
  if (today.length) {
    const names = today.slice(0, 3).map(entry => entry.member.realName).join('、')
    return today.length > 3
      ? `今天生日 · ${names} 等 ${today.length} 人`
      : `今天生日 · ${names}`
  }
  const upcoming = next.value
  return upcoming
    ? `本月 ${props.entries.length} 位寿星 · 下一位 ${upcoming.member.realName} ${formatBirthdayCountdown(upcoming.offset)}`
    : `本月 ${props.entries.length} 位寿星`
})
</script>

<template>
  <section
    class="bday"
    :class="{ 'is-today': todayList.length > 0, 'is-open': expanded }"
  >
    <button class="bday__head" type="button" @click="expanded = !expanded">
      <span class="bday__cake">
        <MediaIcon name="cake" :size="19" />
      </span>

      <span class="bday__text">
        <span class="bday__title">{{ summary }}</span>
        <span class="bday__meta">{{ month }} 月生日墙 · 共 {{ entries.length }} 位寿星</span>
      </span>

      <span class="bday__toggle">
        {{ expanded ? '收起' : '展开' }}
        <el-icon class="bday__arrow" :class="{ 'is-open': expanded }">
          <ArrowDown />
        </el-icon>
      </span>
    </button>

    <!-- 折叠用 grid-template-rows 0fr→1fr 过渡（高度自适应且可动画），
         收起时一并切 visibility，免得被裁掉的内容还能被 Tab 聚焦 -->
    <div class="bday__wall-wrap" :class="{ 'is-open': expanded }">
      <div class="bday__wall">
        <ul class="bday__list">
          <li v-for="entry in entries" :key="memberCardKey(entry.member)">
            <button
              class="bday-item"
              type="button"
              :class="{ 'is-today': entry.offset === 0, 'is-past': entry.offset < 0 }"
              :title="`查看 ${entry.member.realName} 的资料`"
              @click="emit('select', entry.member)"
            >
              <el-image class="bday-item__avatar" :src="entry.member.avatar" fit="cover">
                <template #error>
                  <span class="bday-item__fallback">
                    <el-icon :size="15">
                      <User />
                    </el-icon>
                  </span>
                </template>
              </el-image>

              <span class="bday-item__main">
                <span class="bday-item__name ellipsis">{{ entry.member.realName }}</span>
                <span class="bday-item__team ellipsis">
                  {{ entry.member.teamName || entry.member.groupName }}
                </span>
              </span>

              <span class="bday-item__side">
                <span class="bday-item__date">{{ entry.month }}/{{ entry.day }}</span>
                <span class="bday-item__countdown">{{ formatBirthdayCountdown(entry.offset) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
/* 生日主题色：日常走玫粉（与直播氛围色同族），今天有人生日时升为鎏金 */
.bday {
  --bday-accent: var(--color-lives);

  margin-bottom: 14px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--bday-accent) 6%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bday-accent) 18%, transparent);
  overflow: hidden;
}

.bday.is-today {
  --bday-accent: var(--color-follow);

  /* 今天有人生日：整条点亮，左上聚光 + 金色描边 */
  background:
    radial-gradient(420px 90px at 0% 0%, color-mix(in srgb, var(--color-follow) 22%, transparent), transparent 72%),
    color-mix(in srgb, var(--color-follow) 8%, var(--el-bg-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-follow) 42%, transparent);
}

/* ===== 折叠态的一行 ===== */
.bday__head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  font-family: inherit;
  text-align: left;
  background: transparent;
  cursor: pointer;

  &:hover .bday__toggle {
    color: var(--brand-primary-dark);
  }
}

.bday__cake {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #fff;
  background: linear-gradient(135deg, color-mix(in srgb, var(--bday-accent) 70%, #fff), var(--bday-accent));
  box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--bday-accent) 60%, transparent);
}

.bday.is-today .bday__cake {
  animation: bday-bob 2.4s ease-in-out infinite;
}

@keyframes bday-bob {
  0%,
  100% {
    transform: translateY(0) rotate(-4deg);
  }

  50% {
    transform: translateY(-2px) rotate(4deg);
  }
}

.bday__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bday__title {
  font-size: 13px;
  font-weight: 600;
  color: color-mix(in srgb, var(--bday-accent) 68%, #1c1a2e);
}

.bday__meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.bday__toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  transition: color 0.18s ease;
}

.bday__arrow {
  font-size: 12px;
  transition: transform 0.25s ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

/* ===== 展开的生日墙 ===== */
.bday__wall-wrap {
  display: grid;
  grid-template-rows: 0fr;
  visibility: hidden;
  transition:
    grid-template-rows 0.3s ease,
    visibility 0s linear 0.3s;

  &.is-open {
    grid-template-rows: 1fr;
    visibility: visible;
    transition:
      grid-template-rows 0.3s ease,
      visibility 0s;
  }
}

.bday__wall {
  min-height: 0;
  overflow: hidden;
}

.bday__list {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  margin: 0;
  padding: 0 12px 12px;
  list-style: none;
}

.bday-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: var(--radius-md);
  font-family: inherit;
  text-align: left;
  background: var(--el-bg-color);
  box-shadow: inset 0 0 0 1px var(--el-border-color-lighter);
  cursor: pointer;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--bday-accent) 42%, transparent),
      var(--shadow-sm);
  }

  /* 今天生日：金色描边 + 柔光，墙里最亮的一块 */
  &.is-today {
    background: color-mix(in srgb, var(--color-follow) 10%, var(--el-bg-color));
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-follow) 52%, transparent),
      0 0 12px -4px color-mix(in srgb, var(--color-follow) 65%, transparent);
  }

  /* 本月已过完：弱化，但仍留在墙上（这也是本月寿星） */
  &.is-past {
    opacity: 0.6;
  }
}

.bday-item__avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color-light);
}

.bday-item__fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--el-text-color-placeholder);
}

.bday-item__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.bday-item__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.bday-item__team {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.bday-item__side {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.bday-item__date {
  font-size: 12px;
  font-weight: 700;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.bday-item__countdown {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.7;
  color: color-mix(in srgb, var(--bday-accent) 72%, #1c1a2e);
  background: color-mix(in srgb, var(--bday-accent) 14%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .bday.is-today .bday__cake {
    animation: none;
  }

  .bday__wall-wrap,
  .bday__arrow,
  .bday-item {
    transition: none;
  }

  .bday-item:hover {
    transform: none;
  }
}
</style>
