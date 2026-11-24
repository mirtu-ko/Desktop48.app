<script setup lang="ts">
import { Document } from '@element-plus/icons-vue'
import { friendLinks, linkHost, referenceProjects } from '@renderer/data/setting-links'

/**
 * 关于组：低频静态内容默认折叠，展开后按「相关链接 / 权利声明 / 致谢」三段呈现。
 * 链接与致谢清单在 data/setting-links.ts，改链接不用碰模板。
 */

/** logo 加载失败时隐藏图片，露出首字磁贴 */
function hideLogo(event: Event) {
  (event.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <h2 class="setting-group-label" data-setting-group="about">
    关于
  </h2>
  <section class="setting-card glass-card">
    <details class="setting-about">
      <summary class="setting-about-summary">
        <span
          class="row-icon icon-tile"
          style="--tile-color: #909399"
        >
          <el-icon><Document /></el-icon>
        </span>
        <span class="setting-about-text">
          <span class="setting-about-title">关于本应用</span>
          <span class="setting-about-desc">主站与源码、相关链接、版权声明与致谢</span>
        </span>
        <span class="setting-about-arrow" aria-hidden="true" />
      </summary>
      <div class="row-body">
        <div class="friend-links setting-about-section">
          <span class="links-label">相关链接</span>
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
        <div class="legal-grid setting-about-section">
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
        <div class="friend-links setting-about-section">
          <span class="links-label">参考项目致谢</span>
          <div class="credits-grid">
            <a
              v-for="project in referenceProjects"
              :key="project.name"
              class="credit-link"
              :href="project.url"
              target="_blank"
              rel="noopener"
            >
              <span class="credit-name">{{ project.name }}</span>
              <span class="credit-role ellipsis">{{ project.role }}</span>
            </a>
          </div>
        </div>
      </div>
    </details>
  </section>
</template>

<style scoped lang="scss">
/* 关于组：低频静态内容默认折叠；原生 details 免维护一份展开状态。
   折叠头部的骨架（图标磁贴尺寸、虚线分隔）由 setting-shared 的 .row-icon / .row-body 提供 */
.setting-about-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  list-style: none;

  &::-webkit-details-marker {
    display: none;
  }
}

.setting-about-text {
  flex: 1;
  min-width: 0;
}

.setting-about-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  transition: color 0.18s ease;
}

.setting-about-summary:hover .setting-about-title {
  color: var(--brand-primary);
}

.setting-about-desc {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}

.setting-about-arrow {
  flex: none;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  border-right: 1.5px solid var(--el-text-color-placeholder);
  border-bottom: 1.5px solid var(--el-text-color-placeholder);
  transform: rotate(45deg);
  transition: transform 0.18s ease;
}

.setting-about[open] .setting-about-arrow {
  transform: rotate(-135deg);
}

/* 展开正文沿用 .row-body 的虚线分隔，这里只补小节间距 */
.setting-about-section + .setting-about-section {
  margin-top: 14px;
}

.legal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.legal-block {
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
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

/* 友情链接：logo 卡片网格，悬浮上浮高亮 */
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
  border-radius: var(--radius-md);
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

/* 参考项目致谢：轻量文字卡，避免和右侧声明区抢视觉 */
.credits-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
}

.credit-link {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
    box-shadow: var(--shadow-sm);
    transform: translateY(-2px);

    .credit-name {
      color: var(--brand-primary);
    }
  }
}

.credit-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  transition: color 0.18s ease;
}

.credit-role {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
</style>
