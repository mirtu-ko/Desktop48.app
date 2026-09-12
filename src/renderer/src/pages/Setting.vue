<script setup lang="ts">
import { Connection, Cpu, Document, Folder, Hide } from '@element-plus/icons-vue'
import { useAppConfig } from '@renderer/composables/use-app-config'
import { useBlockedMembersStore } from '@renderer/stores/blocked-members'
import Constants from '@renderer/utils/constants'
import { ElMessageBox } from 'element-plus'
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 配置三项（下载目录 / ffmpeg 目录 / User-Agent）的状态与读写收口在 use-app-config.ts
const {
  downloadDirectory,
  ffmpegDirectory,
  userAgent,
  loadAppConfig,
  setDownloadDirectory,
  openDownloadDirectory,
  setFfmpegDirectory,
  openFfmpegDirectory,
  setUserAgent,
} = useAppConfig()

/** 屏蔽名单：模块级共享状态，机制见 use-blocked-members.ts */
const { blockedMembers, refreshBlockedMembers, unblockMember, clearBlockedMembers } = useBlockedMembersStore()

onMounted(async () => {
  await loadAppConfig()
  await refreshBlockedMembers()
})

/** 清空名单前二次确认 */
async function confirmClearBlockedMembers() {
  try {
    await ElMessageBox.confirm(`确定清空全部 ${blockedMembers.value.length} 个屏蔽成员？`, '清空屏蔽名单', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  }
  catch {
    return // 用户取消
  }
  await clearBlockedMembers()
}

/** 屏蔽 / 解除成员的入口在成员页 */
function goMembers() {
  router.push('/members')
}

/** 友情链接（logo 加载失败时回退为首字磁贴）；主题色复用 Constants 的语义色 */
interface FriendLink {
  name: string
  url: string
  abbr: string
  color: string
  logo?: string
  /** 内联品牌 SVG 图形（优先于 abbr 文本磁贴），viewBox 默认 0 0 24 24 */
  glyph?: string
  glyphBox?: string
}

const friendLinks: FriendLink[] = [
  { name: 'SNH48 官方网站', url: 'https://www.snh48.com/', abbr: 'SNH', color: Constants.GroupTabs[1].color },
  { name: 'SNH48 官方直播', url: 'https://live.48.cn/', abbr: 'Live', color: Constants.Theme.SETTING },
  { name: '口袋48 APP', url: 'https://h5.48.cn/pocket48/index_pc.html', abbr: '48', color: Constants.Theme.MEMBERS, logo: 'https://h5.48.cn/pocket48/image/logo.png' },
  { name: '塞纳河48 APP', url: 'https://www.ckg48.cn/', abbr: 'CKG', color: Constants.Theme.SHOWS, logo: 'https://www.ckg48.cn/favicon.ico' },
  {
    name: '新浪微博',
    url: 'https://weibo.com/u/2689280541',
    abbr: '微博',
    color: '#e6162d',
    glyph: 'M407 177.6c7.6-24-13.4-46.8-37.4-41.7-22 4.8-28.8-28.1-7.1-32.8 50.1-10.9 92.3 37.1 76.5 84.8-6.8 21.2-38.8 10.8-32-10.3zM214.8 446.7c-106.3 0-214.8-51.4-214.8-136.3 0-44.3 28-95.4 76.3-143.7 99.7-99.7 203.2-100.9 173.6-5.7-4 13.1 12.3 5.7 12.3 6 79.5-33.6 140.5-16.8 114 51.4-3.7 9.4 1.1 10.9 8.3 13.1 135.7 42.3 34.8 215.2-169.7 215.2zM358.5 300.4c-5.4-55.7-78.5-94-163.4-85.7-84.8 8.6-148.8 60.3-143.4 116s78.5 94 163.4 85.7c84.8-8.6 148.8-60.3 143.4-116zM347.9 35.1c-25.9 5.6-16.8 43.7 8.3 38.3 72.3-15.2 134.8 52.8 111.7 124-7.4 24.2 29.1 37 37.4 12 31.9-99.8-55.1-195.9-157.4-174.3zm-78.5 311c-17.1 38.8-66.8 60-109.1 46.3-40.8-13.1-58-53.4-40.3-89.7 17.7-35.4 63.1-55.4 103.4-45.1 42 10.8 63.1 50.2 46 88.5zm-86.3-30c-12.9-5.4-30 .3-38 12.9-8.3 12.9-4.3 28 8.6 34 13.1 6 30.8 .3 39.1-12.9 8-13.1 3.7-28.3-9.7-34zm32.6-13.4c-5.1-1.7-11.4 .6-14.3 5.4-2.9 5.1-1.4 10.6 3.7 12.9 5.1 2 11.7-.3 14.6-5.4 2.8-5.2 1.1-10.9-4-12.9z',
    glyphBox: '0 0 512 512',
  },
  {
    name: '哔哩哔哩',
    url: 'https://space.bilibili.com/2832224',
    abbr: 'B站',
    color: '#00a1d6',
    glyph: 'M488.6 104.1c16.7 18.1 24.4 39.7 23.3 65.7l0 202.4c-.4 26.4-9.2 48.1-26.5 65.1-17.2 17-39.1 25.9-65.5 26.7L92 464c-26.4-.8-48.2-9.8-65.3-27.2-17.1-17.4-26-40.3-26.7-68.6L0 169.8c.8-26 9.7-47.6 26.7-65.7 17.1-16.3 38.8-25.3 65.3-26.1l29.4 0-25.4-25.8c-5.7-5.7-8.6-13-8.6-21.8s2.9-16.1 8.6-21.8 13-8.6 21.9-8.6 16.1 2.9 21.9 8.6l73.3 69.4 88 0 74.5-69.4C381.7 2.9 389.2 0 398 0s16.1 2.9 21.9 8.6c5.7 5.7 8.6 13 8.6 21.8s-2.9 16.1-8.6 21.8L394.6 78 423.9 78c26.4 .8 48 9.8 64.7 26.1zm-38.8 69.7c-.4-9.6-3.7-17.4-10.7-23.5-5.2-6.1-14-9.4-22.7-9.8l-320.4 0c-9.6 .4-17.4 3.7-23.6 9.8-6.1 6.1-9.4 13.9-9.8 23.5l0 194.4c0 9.2 3.3 17 9.8 23.5s14.4 9.8 23.6 9.8l320.4 0c9.2 0 17-3.3 23.3-9.8s9.7-14.3 10.1-23.5l0-194.4zM185.5 216.5c6.3 6.3 9.7 14.1 10.1 23.2l0 33.3c-.4 9.2-3.7 16.9-9.8 23.2-6.2 6.3-14 9.5-23.6 9.5s-17.5-3.2-23.6-9.5-9.4-14-9.8-23.2l0-33.3c.4-9.1 3.8-16.9 10.1-23.2s13.2-9.6 23.3-10c9.2 .4 17 3.7 23.3 10zm191.5 0c6.3 6.3 9.7 14.1 10.1 23.2l0 33.3c-.4 9.2-3.7 16.9-9.8 23.2s-14 9.5-23.6 9.5-17.4-3.2-23.6-9.5c-7-6.3-9.4-14-9.7-23.2l0-33.3c.3-9.1 3.7-16.9 10-23.2s14.1-9.6 23.3-10c9.2 .4 17 3.7 23.3 10z',
    glyphBox: '0 0 512 512',
  },
  {
    name: 'YouTube',
    url: 'https://www.youtube.com/@SNH48Official',
    abbr: 'YT',
    color: '#ff0000',
    glyph: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
]

/** 展示链接域名 */
function linkHost(url: string) {
  try {
    return new URL(url).hostname
  }
  catch {
    return url
  }
}

/** logo 加载失败时隐藏图片，露出首字磁贴 */
function hideLogo(event: Event) {
  (event.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <el-scrollbar
    class="scrollbar-wrapper"
    wrap-class="scrollbar-wrapper"
  >
    <div class="setting-root">
      <!-- User-Agent -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': Constants.Theme.SETTING }"
          >
            <el-icon><Connection /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              User-Agent
            </div>
            <div class="row-desc">
              访问直播 / 回放接口时使用的浏览器标识
            </div>
          </div>
          <el-input
            v-model="userAgent"
            class="row-control"
            placeholder="设置 User-Agent"
          />
          <el-button
            type="primary"
            class="row-action"
            @click="setUserAgent"
          >
            保存
          </el-button>
        </div>
      </section>

      <!-- 默认下载目录 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': Constants.Theme.DOWNLOADS }"
          >
            <el-icon><Folder /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              默认下载目录
            </div>
            <div class="row-desc">
              回放与录制文件的保存位置
            </div>
          </div>
          <el-input
            v-model="downloadDirectory"
            class="row-control"
            readonly
            placeholder="点击输入框选择目录"
            @click="setDownloadDirectory"
          />
          <div class="row-actions">
            <el-button @click="openDownloadDirectory">
              打开目录
            </el-button>
            <el-button
              type="primary"
              @click="setDownloadDirectory"
            >
              选择
            </el-button>
          </div>
        </div>
      </section>

      <!-- ffmpeg 目录 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': Constants.Theme.SHOWS }"
          >
            <el-icon><Cpu /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              FFmpeg 目录
            </div>
            <div class="row-desc">
              录制功能依赖的 ffmpeg 程序所在位置
            </div>
          </div>
          <el-input
            v-model="ffmpegDirectory"
            class="row-control"
            readonly
            placeholder="点击输入框选择目录"
            @click="setFfmpegDirectory"
          />
          <div class="row-actions">
            <el-button @click="openFfmpegDirectory">
              打开目录
            </el-button>
            <el-button
              type="primary"
              @click="setFfmpegDirectory"
            >
              选择
            </el-button>
          </div>
        </div>
      </section>

      <!-- 屏蔽成员 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            :style="{ '--tile-color': Constants.Theme.LIVES }"
          >
            <el-icon><Hide /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              屏蔽成员
            </div>
            <div class="row-desc">
              已屏蔽 {{ blockedMembers.length }} 名成员，其直播与回放将不再展示
            </div>
          </div>
          <div class="row-actions">
            <el-button
              type="danger"
              plain
              :disabled="!blockedMembers.length"
              @click="confirmClearBlockedMembers"
            >
              清空
            </el-button>
            <el-button
              type="primary"
              @click="goMembers"
            >
              屏蔽成员
            </el-button>
          </div>
        </div>
        <div class="row-body">
          <div v-if="blockedMembers.length" class="tag-list">
            <el-tag
              v-for="member in blockedMembers"
              :key="member.userId"
              closable
              :color="`#${member.teamColor}`"
              effect="dark"
              @close="unblockMember(member.userId)"
            >
              {{ member.realName }}
            </el-tag>
          </div>
          <div v-else class="empty-hint">
            尚未屏蔽任何成员，点击「屏蔽成员」前往成员页操作
          </div>
        </div>
      </section>

      <!-- 权利声明 -->
      <section class="setting-card glass-card">
        <div class="setting-row">
          <span
            class="row-icon icon-tile"
            style="--tile-color: #909399"
          >
            <el-icon><Document /></el-icon>
          </span>
          <div class="row-text">
            <div class="row-title">
              权利声明
            </div>
            <div class="row-desc">
              免责声明与版权归属说明
            </div>
          </div>
        </div>
        <div class="row-body">
          <div class="friend-links">
            <span class="links-label">推荐链接</span>
            <div class="links-grid">
              <a
                v-for="link in friendLinks"
                :key="link.name"
                class="friend-link"
                :href="link.url"
                target="_blank"
                rel="noopener"
              >
                <span class="link-logo icon-tile" :style="{ '--tile-color': link.color }">
                  <svg
                    v-if="link.glyph"
                    class="link-glyph"
                    :viewBox="link.glyphBox || '0 0 24 24'"
                    aria-hidden="true"
                  >
                    <path :d="link.glyph" />
                  </svg>
                  <span v-else class="link-abbr">{{ link.abbr }}</span>
                  <img v-if="link.logo" :src="link.logo" alt="" @error="hideLogo">
                </span>
                <span class="link-meta">
                  <span class="link-name">{{ link.name }}</span>
                  <span class="link-host ellipsis">{{ linkHost(link.url) }}</span>
                </span>
              </a>
            </div>
          </div>
        </div>
        <div class="legal-grid">
          <div class="legal-block">
            <p class="legal-title">
              版权声明
            </p>
            <p class="legal-text">
              所有数据来源于SNH48 官方网站、口袋48 APP 等互联网公开数据，本应用不拥有任何资源的版权。
            </p>
            <p class="legal-text">
              包括且不限于商标、肖像权、音视频版权，均归 SNH48 Group 及其运营方（上海丝芭文化传媒集团有限公司）和其他相关权利人所有。
            </p>
          </div>
          <div class="legal-block">
            <p class="legal-title">
              免责声明
            </p>
            <p class="legal-text">
              本应用不对任何音视频资源的版权合法性承担责任。用户在使用本应用时，应当遵守相关法律法规，不得用于商业用途。
            </p>
            <p class="legal-text">
              任何因使用本应用而产生的版权纠纷或法律责任，均由用户自行承担。本应用不承担任何责任。
            </p>
          </div>
        </div>
      </section>
    </div>
  </el-scrollbar>
</template>

<style scoped lang="scss">
.setting-root {
  max-width: 880px;
  margin: 0 auto;
  /* 底部留出悬浮 Dock 的高度（--dock-reserve），避免最后一张卡片被遮挡 */
  padding: 20px 24px var(--dock-reserve);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 设置卡片：磨砂玻璃基底见全局 .glass-card */
.setting-card {
  padding: 18px 20px;
  border-radius: var(--radius-lg);
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 渐变主题图标磁贴：骨架见全局 .icon-tile（与底部 Dock 的视觉语言一致），此处仅定尺寸 */
.row-icon {
  width: 44px;
  height: 44px;

  .el-icon {
    font-size: 21px;
  }
}

.row-text {
  flex-shrink: 0;
  width: 190px;

  .row-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .row-desc {
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--el-text-color-secondary);
  }
}

.row-control {
  flex: 1;
  min-width: 200px;
  cursor: pointer;
}

.row-actions {
  flex-shrink: 0;
  /* 屏蔽成员行没有 row-control 占位，auto 外边距保证按钮与其他行一样靠右 */
  margin-left: auto;
  display: flex;
}

/* 卡片正文：与标题行之间用虚线分隔 */
.row-body {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

/* 屏蔽名单：队伍色标签（:color 内联样式优先级高，需 !important 覆盖） */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  :deep(.el-tag) {
    color: #fff !important;
    border-color: rgba(255, 255, 255, 0.45) !important;

    .el-tag__close {
      color: #fff;

      &:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.3);
      }
    }
  }
}

/* 屏蔽名单空态：样式见全局 .empty-hint */

/* 权利声明：小字号次要色，低调呈现；两类声明做成响应式双栏卡片 */
.legal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.legal-block {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: color-mix(in srgb, var(--brand-primary) 4%, transparent);
}

.legal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);

  &::before {
    content: '';
    flex: none;
    width: 3px;
    height: 13px;
    border-radius: 2px;
    background: linear-gradient(180deg, var(--brand-primary-light), var(--brand-primary));
  }
}

.legal-text {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}

.legal-text:last-child {
  margin-bottom: 0;
}

/* 友情链接：logo 卡片网格，悬浮上浮高亮（现位于权利声明卡片顶部，无需上边距） */
.friend-links {
  .links-label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--el-text-color-secondary);

    &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--el-border-color-lighter);
    }
  }
}

.links-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}

.friend-link {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  text-decoration: none;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
    box-shadow: var(--shadow-sm);
    transform: translateY(-2px);

    .link-name {
      color: var(--brand-primary);
    }
  }

  /* 主题色首字磁贴：渐变骨架见全局 .icon-tile；logo 加载失败 / 无 logo 时兜底展示 */
  .link-logo {
    position: relative;
    display: flex;
    width: 38px;
    height: 38px;
    overflow: hidden;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 700;

    /* 中英文短标识都居中且不换行 */
    .link-abbr {
      padding: 0 2px;
      line-height: 1;
      white-space: nowrap;
    }

    /* 内联品牌图标：白色剪影叠在主题色磁贴上，自带轻微投影更像官方 logo */
    .link-glyph {
      width: 22px;
      height: 22px;
      fill: #fff;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.28));
    }

    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #fff;
    }
  }

  .link-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .link-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
    transition: color 0.18s ease;
  }

  .link-host {
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}

/* 品牌渐变主按钮已全局统一，见 app.scss */
</style>
