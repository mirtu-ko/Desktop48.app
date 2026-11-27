import { describe, expect, it } from 'vitest'
import { classifyChannelGate } from '../src/main/pocket48/pocket-room-api'

describe('classifyChannelGate（room/info 失败回包定性）', () => {
  it('暗号信封 → question，message 不当作展示原文', () => {
    const gate = classifyChannelGate({
      status: 2001,
      message: '{"questionId":"986","question":"层层最喜欢的数字！"}',
    })
    expect(gate.kind).toBe('question')
    expect(gate.status).toBe(2001)
    expect(gate.message).toBe('')
  })

  it('赠送鸡腿门槛（纯文本、无 questionId）→ chicken-leg 并保留原文', () => {
    // 线上实际回包（2026-11，频道 6932231）：这就是早先被当成网络失败的那一条
    const message = '最近30天内赠送过鸡腿礼物(*每30分钟整点刷新)可访问频道'
    const gate = classifyChannelGate({ status: 2000, message })
    expect(gate.kind).toBe('chicken-leg')
    expect(gate.message).toBe(message)
  })

  it('结构优先于码值：暗号信封即使码是 2000 也判 question', () => {
    expect(classifyChannelGate({ status: 2000, message: '{"questionId":"1","question":"?"}' }).kind).toBe('question')
  })

  it('码值兜底：2002 归 contribution（贡献与守护同码，分不出是哪一种）', () => {
    expect(classifyChannelGate({ status: 2002, message: '需要贡献' }).kind).toBe('contribution')
    // 2003 照 2002 处理：两者都归 contribution，界面按「未通过准入」说话
    expect(classifyChannelGate({ status: 2003, message: '需要守护' }).kind).toBe('contribution')
  })

  it('赠送鸡腿的实测回包（2002 + 纯文本）是 chicken-leg，不能被码值抢走', () => {
    const gate = classifyChannelGate({ status: 2002, message: '最近30天内赠送过鸡腿礼物(*每30分钟整点刷新)可访问频道' })
    expect(gate.kind).toBe('chicken-leg')
    expect(gate.status).toBe(2002)
  })

  it('认不出的文案不猜：归 unknown 且保留码与原文（供排查）', () => {
    const gate = classifyChannelGate({ status: 500, message: '系统繁忙' })
    expect(gate.kind).toBe('unknown')
    expect(gate.status).toBe(500)
    expect(gate.message).toBe('系统繁忙')
  })

  it('空 message 不崩', () => {
    expect(classifyChannelGate({}).kind).toBe('unknown')
  })
})
