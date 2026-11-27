<script setup lang="ts">
import type { usePocketAccount } from '@renderer/composables/use-pocket-account'
import type { InputInstance } from 'element-plus'
import { POCKET_CLIENT_LABEL } from '@common/pocket-client-profile'
import { Lock, User, WarningFilled } from '@element-plus/icons-vue'
import { pocketAuthState } from '@renderer/stores/pocket-auth'
import { computed, ref } from 'vue'

/**
 * 账号组：口袋48账号卡 + 登录弹窗 + 登录状态验证弹窗。
 *
 * 全部逻辑在 use-pocket-account（登录态展示 / 短信与 Token 登录 / 退出 / 登录有效性验证）；
 * 本组件负责模板，并把「签到」「拉取关注」两个动作交回父页——它们涉及其他域的状态。
 *
 * ⚠️ composable 返回的是普通对象，其内部 ref 在模板里**不会**自动解包。所以这里一律
 * 解构到 setup 顶层：顶层 ref 由模板自动解包，`loginTab` / `smsForm` 等直接用，
 * 不会出现 `account.xxx.value` 漏写导致的「渲染成 [object Object] / 布尔位恒真」问题。
 */
const props = defineProps<{
  account: ReturnType<typeof usePocketAccount>
  checkingIn: boolean
  followSyncing: boolean
}>()

const emit = defineEmits<{
  checkIn: []
  syncFollow: []
}>()

const auth = pocketAuthState

/** 登录身份是固定的塞纳河48 客户端，只在弹窗副标题里说明，不再提供选择 */
const clientLabel = POCKET_CLIENT_LABEL

const {
  avatarUrl,
  rowTitle,
  loginDialogVisible,
  loginTab,
  areaOptions,
  smsForm,
  tokenForm,
  smsSendable,
  smsLoginable,
  tokenLoginable,
  captchaPending,
  openLoginDialog,
  sendCode,
  submitSmsLogin,
  submitTokenLogin,
  confirmLogout,
  verifying,
  verifyDialogVisible,
  verifyResult,
  verifyFailed,
  verifyFailedMessage,
  savedDays,
  verifyLogin,
  reloginFromVerify,
} = props.account

/** 验证成功时的资料快照：模板据此收窄非空，避免满屏非空断言 */
const verifiedInfo = computed(() => (verifyResult.value?.valid ? verifyResult.value : null))

/** 短信登录手机号输入框：弹窗打开后自动聚焦，省一次点击 */
const smsMobileRef = ref<InputInstance>()

/** 统计数字：千分位；非数字原样返回 */
function formatCount(value: string): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN') : value
}

/** 弹窗打开后聚焦手机号输入框 */
function focusSmsMobile() {
  smsMobileRef.value?.focus()
}
</script>

<template>
  <h2 class="setting-group-label" data-setting-group="account">
    账号
  </h2>
  <section class="setting-card glass-card">
    <div class="setting-row">
      <span
        class="row-icon icon-tile auth-avatar"
        :class="{ 'is-clickable': auth.loggedIn, 'is-verifying': verifying, 'has-avatar': !!avatarUrl }"
        :style="{ '--tile-color': 'var(--brand-primary)' }"
        :title="auth.loggedIn ? (verifying ? '正在验证登录…' : '点击查看登录状态与账号资料') : ''"
        @click="auth.loggedIn ? verifyLogin() : undefined"
      >
        <img
          v-if="auth.loggedIn && avatarUrl"
          :src="avatarUrl"
          alt="账号头像"
        >
        <el-icon v-else>
          <User />
        </el-icon>
      </span>
      <div class="row-text row-text--fluid">
        <div class="row-title">
          {{ rowTitle }}
        </div>
        <div class="row-desc">
          <template v-if="auth.loggedIn">
            账号<template v-if="auth.mobileMasked">
              （{{ auth.mobileMasked }}）
            </template>
          </template>
          <template v-else>
            登录后可在直播页实时查看口袋互动消息
          </template>
        </div>
      </div>
      <div class="row-actions">
        <template v-if="auth.loggedIn">
          <el-tag
            v-if="auth.plainFallback"
            type="warning"
            size="small"
            class="auth-fallback-tag"
          >
            明文存储
          </el-tag>
          <el-button
            :loading="checkingIn"
            @click="emit('checkIn')"
          >
            签到
          </el-button>
          <el-button
            type="danger"
            plain
            @click="confirmLogout"
          >
            退出登录
          </el-button>
        </template>
        <el-button
          v-else
          type="primary"
          @click="openLoginDialog"
        >
          登录
        </el-button>
      </div>
    </div>
  </section>

  <el-dialog
    v-model="loginDialogVisible"
    width="min(600px, calc(100vw - 32px))"
    align-center
    class="setting-dialog"
    :close-on-click-modal="false"
    append-to-body
    @opened="focusSmsMobile"
  >
    <template #header>
      <div class="login-head">
        <span class="login-head-icon icon-tile" :style="{ '--tile-color': 'var(--brand-primary)' }">
          <el-icon :size="18"><Lock /></el-icon>
        </span>
        <div class="login-head-text">
          <h3 class="login-head-title">
            登录口袋48账号
          </h3>
          <p class="login-head-sub">
            以「{{ clientLabel }}」客户端身份登录 · 短信验证码或 Token 均可
          </p>
        </div>
      </div>
    </template>
    <el-tabs
      v-model="loginTab"
      class="login-tabs"
    >
      <el-tab-pane
        label="短信验证码"
        name="sms"
      >
        <div class="login-form">
          <div class="login-mobile-row">
            <el-select
              v-model="smsForm.area"
              class="login-area"
              :disabled="smsForm.loggingIn || smsForm.areaLocked"
            >
              <el-option
                v-for="area in areaOptions"
                :key="area.value"
                :label="area.label"
                :value="area.value"
              />
            </el-select>
            <el-input
              ref="smsMobileRef"
              v-model="smsForm.mobile"
              class="login-mobile"
              placeholder="手机号"
              :maxlength="smsForm.area === '86' ? 11 : 15"
              :disabled="smsForm.loggingIn"
            />
          </div>
          <div
            v-if="smsForm.captcha"
            class="login-captcha"
          >
            <div class="captcha-question">
              <el-icon><WarningFilled /></el-icon>
              {{ smsForm.captcha.question }}
            </div>
            <el-radio-group
              v-model="smsForm.captcha.answer"
              class="captcha-options"
            >
              <el-radio
                v-for="option in smsForm.captcha.options"
                :key="option"
                :value="option"
              >
                {{ option }}
              </el-radio>
            </el-radio-group>
          </div>
          <div class="login-code-row">
            <el-input
              v-model="smsForm.code"
              placeholder="验证码"
              maxlength="8"
              :disabled="smsForm.loggingIn"
              @keyup.enter="smsLoginable && submitSmsLogin()"
            />
            <el-button
              class="login-code-btn"
              :disabled="!smsSendable || smsForm.countdown > 0 || captchaPending"
              :loading="smsForm.sending"
              @click="sendCode"
            >
              {{ smsForm.countdown > 0 ? `${smsForm.countdown}s` : (smsForm.captcha ? '重新发送' : '发送验证码') }}
            </el-button>
          </div>
          <el-button
            type="primary"
            class="login-submit"
            :disabled="!smsLoginable"
            :loading="smsForm.loggingIn"
            @click="submitSmsLogin"
          >
            登录
          </el-button>
        </div>
      </el-tab-pane>
      <el-tab-pane
        label="Token 粘贴"
        name="token"
      >
        <div class="login-form">
          <el-input
            v-model="tokenForm.token"
            type="textarea"
            :rows="6"
            placeholder="粘贴口袋48 token（抓包或从其他工具获取）"
            class="login-token-input"
          />
          <el-input
            v-model="tokenForm.mobile"
            placeholder="手机号（选填，用于下次登录预填）"
            maxlength="15"
          />
          <el-button
            type="primary"
            class="login-submit"
            :disabled="!tokenLoginable"
            :loading="tokenForm.loggingIn"
            @click="submitTokenLogin"
          >
            登录
          </el-button>
        </div>
      </el-tab-pane>
    </el-tabs>
    <div class="login-hint">
      <el-icon class="login-hint-icon">
        <Lock />
      </el-icon>
      <p>
        凭证仅保存在本机（safeStorage 加密），不会上传。凭证由服务端掌控有效性，失效需重新登录。
      </p>
    </div>
  </el-dialog>

  <el-dialog
    v-model="verifyDialogVisible"
    :title="verifyFailed ? '登录状态异常' : '登录状态'"
    width="min(520px, calc(100vw - 32px))"
    align-center
    append-to-body
    class="setting-dialog verify-dialog"
  >
    <div v-if="verifying" class="verify-loading">
      <span class="verify-spinner" />
      <span>正在向口袋48服务端校验登录状态…</span>
    </div>

    <div v-else-if="verifyFailed" class="verify-fail">
      <el-icon class="verify-fail-icon">
        <WarningFilled />
      </el-icon>
      <p class="verify-fail-message">
        {{ verifyFailedMessage }}
      </p>
      <p class="verify-fail-hint">
        可立即重新登录；若是网络不通，恢复后重试即可。
      </p>
    </div>

    <div v-else-if="verifiedInfo" class="verify-card">
      <div class="verify-head">
        <span class="verify-avatar" :class="{ 'has-avatar': !!avatarUrl }">
          <img v-if="avatarUrl" :src="avatarUrl" alt="账号头像">
          <el-icon v-else>
            <User />
          </el-icon>
        </span>
        <div class="verify-idblock">
          <div class="verify-nick">
            {{ verifiedInfo!.nickname || auth.nickname || '口袋48用户' }}
            <span v-if="verifiedInfo!.level" class="verify-level">Lv.{{ verifiedInfo!.level }}</span>
          </div>
          <div class="verify-uid">
            ID {{ verifiedInfo!.userId || '—' }}
          </div>
        </div>
      </div>

      <p v-if="verifiedInfo!.signature" class="verify-signature">
        「{{ verifiedInfo!.signature }}」
      </p>

      <div class="verify-stats">
        <div class="verify-stat">
          <div class="stat-value">
            {{ verifiedInfo!.moneyOk ? formatCount(String(verifiedInfo!.moneyTotal)) : '—' }}
          </div>
          <div class="stat-label">
            鸡腿
          </div>
        </div>
        <div class="verify-stat">
          <div class="stat-value">
            {{ verifiedInfo!.support ? formatCount(verifiedInfo!.support) : '—' }}
          </div>
          <div class="stat-label">
            鸡翅
          </div>
        </div>
        <div v-if="verifiedInfo!.fans" class="verify-stat">
          <div class="stat-value">
            {{ formatCount(verifiedInfo!.fans) }}
          </div>
          <div class="stat-label">
            粉丝
          </div>
        </div>
        <div v-if="verifiedInfo!.likes" class="verify-stat">
          <div class="stat-value">
            {{ formatCount(verifiedInfo!.likes) }}
          </div>
          <div class="stat-label">
            获赞
          </div>
        </div>
      </div>

      <div class="verify-links">
        <div class="verify-link">
          <span class="verify-link-name">互动消息</span>
          <span class="verify-link-desc">直播弹幕 / 房间功能 / 签到</span>
          <span class="verify-link-state" :class="verifiedInfo!.imOk ? 'is-ok' : 'is-bad'">
            {{ verifiedInfo!.imOk ? '可用' : '不可用' }}
          </span>
        </div>
      </div>

      <div class="verify-local">
        登录凭证：{{ auth.plainFallback ? '明文保存（保存时系统无加密能力）' : '本机安全加密保存' }}<template v-if="savedDays > 0">
          ，已保存 {{ savedDays }} 天
        </template>
      </div>
    </div>

    <template #footer>
      <el-button
        v-if="verifiedInfo"
        :loading="followSyncing"
        @click="emit('syncFollow')"
      >
        拉取关注
      </el-button>
      <el-button @click="verifyDialogVisible = false">
        关闭
      </el-button>
      <el-button
        v-if="verifyFailed"
        type="primary"
        @click="reloginFromVerify"
      >
        重新登录
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
/* 品牌渐变主按钮已全局统一，见 app.scss */

/* ===== 口袋48登录弹窗 ===== */
/* 头部：品牌色图标磁贴 + 主副标题，替代默认的单行标题 */
.login-head {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-right: 24px;
}

.login-head-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
}

.login-head-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}

.login-head-sub {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
}

/* 登录方式 Tab：等宽平分弹窗宽度，视觉重心稳定 */
.login-tabs {
  :deep(.el-tabs__nav) {
    display: flex;
    width: 100%;
  }

  :deep(.el-tabs__item) {
    flex: 1;
    justify-content: center;
    font-size: 14px;
    text-align: center;
  }

  :deep(.el-tabs__nav-wrap::after) {
    background-color: var(--el-border-color-lighter);
  }
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 6px;
}

/* 问答题卡片：服务端反爬（2001），题目 + 单选作答 */
.login-captcha {
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 4%, transparent);

  .captcha-question {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--el-text-color-primary);

    .el-icon {
      flex: none;
      font-size: 15px;
      color: var(--el-color-warning);
    }
  }

  .captcha-options {
    display: flex;
    flex-wrap: wrap;
    column-gap: 14px;
  }
}

.login-mobile-row {
  display: flex;
  gap: 8px;

  .login-area {
    flex: 0 0 150px;
  }

  .login-mobile {
    flex: 1;
  }
}

.login-code-row {
  display: flex;
  gap: 8px;

  .login-code-btn {
    flex-shrink: 0;
    /* 固定最小宽度避免 60s 倒计时数字宽度抖动 */
    min-width: 108px;
  }
}

.login-submit {
  width: 100%;
  height: 38px;
  margin-top: 2px;
  font-size: 14px;
  font-weight: 500;
}

.login-token-input {
  :deep(.el-textarea__inner) {
    font-family: var(--el-font-family, monospace);
    font-size: 12px;
    word-break: break-all;
  }
}

.login-hint {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);

  p {
    margin: 0;
  }

  .login-hint-icon {
    flex: none;
    margin-top: 2px;
    font-size: 13px;
    color: var(--el-text-color-placeholder);
  }
}

/* 明文存储降级提示 */
.auth-fallback-tag {
  margin-right: 4px;
}

/* 已登录头像：点击触发登录有效性验证 */
.auth-avatar {
  overflow: hidden;
  border-radius: 50%;

  /* 头像图自带圆形裁切：有图时去掉磁贴渐变底色，避免透明四角露出紫色 */
  &.has-avatar {
    background: transparent;
    box-shadow: none;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }

  &.is-clickable {
    cursor: pointer;
    transition: filter 0.2s;

    &:hover {
      filter: brightness(1.15);
    }
  }

  &.is-verifying {
    cursor: wait;
    filter: grayscale(0.6) brightness(0.85);
  }
}

/* ===== 登录状态验证弹窗 ===== */

.verify-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 30px 0 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.verify-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--brand-primary) 25%, transparent);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: verify-spin 0.9s linear infinite;
}

@keyframes verify-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 验证失败：图标 + 原因 + 一句出路 */
.verify-fail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 6px 8px;
  text-align: center;

  .verify-fail-icon {
    font-size: 40px;
    color: var(--el-color-warning);
  }

  .verify-fail-message {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .verify-fail-hint {
    margin: 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

/* 资料卡头部：大头像 + 昵称 + 等级徽标 + ID */
.verify-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.verify-avatar {
  display: flex;
  width: 56px;
  height: 56px;
  flex: none;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;

  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
  color: #fff;
  font-size: 24px;

  /* 头像图自带圆形裁切：有图时去掉渐变底色，避免透明四角露出紫色 */
  &.has-avatar {
    background: transparent;
    box-shadow: none;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.verify-idblock {
  min-width: 0;
}

.verify-nick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.verify-level {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--brand-primary-light), var(--brand-primary));
}

.verify-uid {
  margin-top: 3px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

/* 个性签名：弱底色引用块 */
.verify-signature {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-primary) 5%, transparent);
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

/* 统计瓦片：鸡腿 / 鸡翅始终展示，粉丝 / 获赞按服务端返回有无展示 */
.verify-stats {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.verify-stat {
  flex: 1;
  padding: 12px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-md);
  text-align: center;

  .stat-value {
    font-size: 17px;
    font-weight: 700;
    color: var(--el-text-color-primary);
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    margin-top: 3px;
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}

/* 功能链路：互动消息是弹幕功能的实际依赖，单独一行给出可用性 */
.verify-links {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.verify-link {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;

  .verify-link-name {
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .verify-link-desc {
    flex: 1;
    color: var(--el-text-color-secondary);
  }

  .verify-link-state {
    font-weight: 600;

    &.is-ok {
      color: var(--el-color-success);
    }

    &.is-bad {
      color: var(--el-color-danger);
    }
  }
}

/* 本地凭证：保存方式与保存时长，佐证「这台机器上的登录态」 */
.verify-local {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-placeholder);
}
</style>
