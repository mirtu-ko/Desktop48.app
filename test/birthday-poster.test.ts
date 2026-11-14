import type { BirthdayEntry } from '../src/renderer/src/utils/member-birthday'
import { describe, expect, it, vi } from 'vitest'
import {
  BIRTHDAY_PALETTES,
  BIRTHDAY_WISHES,
  birthdayStamp,
  nextBirthdayWish,
  pad2,
  pickBirthdayPalette,
  posterFileName,
  randomBirthdayWish,
} from '../src/renderer/src/utils/birthday-poster'
import { makeMember } from './fixtures/member'

/** 只测不碰 DOM 的纯函数；绘制函数需要 canvas，由应用内实际导出覆盖 */
const TODAY = new Date(2026, 10, 13)

function makeEntry(): BirthdayEntry {
  return {
    member: makeMember({ realName: '小测试', teamName: 'Team SII', groupName: 'SNH48', birthday: '2001-11-13' }),
    month: 11,
    day: 13,
    offset: 0,
  }
}

describe('生日贺卡文案', () => {
  it('日期戳按月日补零', () => {
    expect(pad2(3)).toBe('03')
    expect(birthdayStamp(makeEntry())).toBe('11.13')
  })

  it('每次打开随机取一句，撞上上一句时顺延，且始终在词库内', () => {
    const size = BIRTHDAY_WISHES.length
    const random = vi.spyOn(Math, 'random')
    for (let i = 0; i < size; i++) {
      random.mockReturnValue((i + 0.5) / size)
      const wish = randomBirthdayWish()
      expect(wish).toBe(BIRTHDAY_WISHES[i])
      expect(BIRTHDAY_WISHES).toContain(wish)
      expect(randomBirthdayWish(wish)).toBe(BIRTHDAY_WISHES[(i + 1) % size])
    }
    random.mockRestore()
  })

  it('换一句按词库顺序循环，未知句子从第一句开始', () => {
    const first = BIRTHDAY_WISHES[0]
    expect(nextBirthdayWish('不在词库里的句子')).toBe(first)
    let current = first
    for (let i = 0; i < BIRTHDAY_WISHES.length; i++) {
      current = nextBirthdayWish(current)
      expect(BIRTHDAY_WISHES).toContain(current)
    }
    expect(current).toBe(first)
  })

  it('建议文件名剥掉路径分隔符与空白，并按当天日期落款', () => {
    const entry = makeEntry()
    entry.member.realName = '小 /测:试 '
    expect(posterFileName(entry, TODAY)).toBe('Desktop48-生日贺卡-小测试-20261113.png')
  })

  it('姓名为空时文件名仍有兜底，不会拼出以连字符结尾的怪名字', () => {
    const entry = makeEntry()
    entry.member.realName = ''
    expect(posterFileName(entry, TODAY)).toBe('Desktop48-生日贺卡-member-20261113.png')
  })

  it('装扮变体循环取值且每套配色完整，负变体也归一到有效下标', () => {
    const size = BIRTHDAY_PALETTES.length
    expect(pickBirthdayPalette(0)).toBe(BIRTHDAY_PALETTES[0])
    expect(pickBirthdayPalette(size + 1)).toBe(BIRTHDAY_PALETTES[1])
    expect(pickBirthdayPalette(-1)).toBe(BIRTHDAY_PALETTES[size - 1])
    for (const palette of BIRTHDAY_PALETTES) {
      expect(palette.name).toBeTruthy()
      expect(palette.flags.length).toBeGreaterThan(0)
      expect(palette.gold).toMatch(/^#[\da-f]{6}$/i)
    }
  })
})
