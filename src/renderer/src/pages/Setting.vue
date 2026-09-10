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
}

const friendLinks: FriendLink[] = [
  { name: 'SNH48 官方网站', url: 'https://www.snh48.com/', abbr: 'SNH', color: Constants.GroupTabs[1].color },
  { name: 'SNH48 官方直播', url: 'https://live.48.cn/', abbr: 'Live', color: Constants.Theme.SETTING },
  { name: '口袋48 APP', url: 'https://h5.48.cn/pocket48/index_pc.html', abbr: '48', color: Constants.Theme.MEMBERS, logo: 'https://h5.48.cn/pocket48/image/logo.png' },
  { name: '塞纳河48 APP', url: 'https://www.ckg48.cn/', abbr: 'CKG', color: Constants.Theme.SHOWS, logo: 'https://www.ckg48.cn/favicon.ico' },
  { name: '新浪微博', url: 'https://weibo.com/u/2689280541', abbr: '微博', color: '#e6162d' },
  { name: '哔哩哔哩', url: 'https://space.bilibili.com/2832224', abbr: 'B站', color: '#00a1d6' },
  { name: 'YouTube', url: 'https://www.youtube.com/@SNH48Official', abbr: 'YT', color: '#ff0000' },
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
          <span class="row-icon" style="--row-color: #909399">
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
                  <span class="link-abbr">{{ link.abbr }}</span>
                  <img v-if="link.logo" :src="link.logo" alt="" @error="hideLogo">
                </span>
                <span class="link-meta">
                  <span class="link-name">{{ link.name }}</span>
                  <span class="link-host ellipsis">{{ linkHost(link.url) }}</span>
                </span>
              </a>
            </div>
          </div>
          <div class="legal-block">
            <p class="legal-title">
              免责声明
            </p>
            <p class="legal-text">
              本应用数据来源于SNH48 官方网站、口袋48 APP 等互联网公开数据。仅供参考，一切数据以官方信息为准。
            </p>
            <p class="legal-text">
              本应用为非官方项目，与 SNH48 Group 及其运营方（上海丝芭文化传媒集团有限公司）无任何关联，所有数据、商标、肖像权等归相关权利人所有。
            </p>
          </div>
          <div class="legal-block">
            <p class="legal-title">
              版权声明
            </p>
            <p class="legal-text">
              本应用不存储任何音视频资源，所有音视频资源均来自互联网公开渠道，版权均归上海丝芭文化传媒集团有限公司及相关权利人所有。
            </p>
            <p class="legal-text">
              本应用不对任何音视频资源的版权合法性承担责任。用户在使用本应用时，应当遵守相关法律法规，不得将本应用用于商业用途。
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

/* 权利声明：小字号次要色，低调呈现 */
.legal-block + .legal-block,
.friend-links + .legal-block {
  margin-top: 10px;
}

/* 友情链接：logo 卡片网格，悬浮上浮高亮（现位于权利声明卡片顶部，无需上边距） */
.friend-links {
  .links-label {
    display: block;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.legal-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.legal-text {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}

.legal-text:last-child {
  margin-bottom: 0;
}

.links-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
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
