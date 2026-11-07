import { FEEDBACK_CONTACT_MAX, FEEDBACK_CONTENT_MAX, formatFeedbackMeta, validateFeedbackInput } from '@common/feedback'
import { describe, expect, it } from 'vitest'

/** common/feedback：反馈输入的规范化与环境摘要文本（上报前的唯一校验入口） */
describe('common/feedback', () => {
  describe('validateFeedbackInput', () => {
    it('去掉首尾空白后放行', () => {
      const result = validateFeedbackInput({ content: '  房间消息不刷新  ' })
      expect(result).toEqual({ ok: true, value: { content: '房间消息不刷新' } })
    })

    it('纯空白视为未填写', () => {
      const result = validateFeedbackInput({ content: '   \n\t ' })
      expect(result).toEqual({ ok: false, reason: '请填写问题描述' })
    })

    it('超长正文拒绝而不是静默截断', () => {
      const result = validateFeedbackInput({ content: 'x'.repeat(FEEDBACK_CONTENT_MAX + 1) })
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.reason).toContain(String(FEEDBACK_CONTENT_MAX))
    })

    it('联系方式为空串时省略该字段，不留空值上报', () => {
      const result = validateFeedbackInput({ content: '问题', contact: '   ' })
      expect(result).toEqual({ ok: true, value: { content: '问题' } })
    })

    it('联系方式去空白后保留', () => {
      const result = validateFeedbackInput({ content: '问题', contact: ' a@b.com ' })
      expect(result).toEqual({ ok: true, value: { content: '问题', contact: 'a@b.com' } })
    })

    it('联系方式超长拒绝', () => {
      const result = validateFeedbackInput({ content: '问题', contact: 'x'.repeat(FEEDBACK_CONTACT_MAX + 1) })
      expect(result.ok).toBe(false)
    })
  })

  describe('formatFeedbackMeta', () => {
    it('输出可粘贴的环境摘要，且不含账号信息', () => {
      const text = formatFeedbackMeta({
        appVersion: '0.2.8',
        platform: 'win32',
        arch: 'x64',
        electron: '44.5.1',
        locale: 'zh-CN',
        clientProfile: 'pocket48-android',
        loggedIn: true,
      }, new Date('2026-11-07T01:30:00'))

      expect(text).toContain('应用版本: v0.2.8')
      expect(text).toContain('运行环境: win32 x64 · Electron 44.5.1')
      expect(text).toContain('客户端身份: pocket48-android')
      expect(text).toContain('登录状态: 已登录')
      // 摘要只报布尔登录态，不得出现手机号等账号字段
      expect(text).not.toContain('手机')
    })
  })
})
