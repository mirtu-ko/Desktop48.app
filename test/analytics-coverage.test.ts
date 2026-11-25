import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 埋点口径的守卫测试。这三条都属于「改一行就静默失效、但看板上要几周后才看得出来」的约定，
// 运行时无法断言（组件测试没有 DOM 环境，见 vitest.config.ts 的 environment: 'node'），
// 因此从源码文本里守——与 element-plus-components.test.ts 同一思路。

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const INDEX_HTML = readSource('../src/renderer/index.html')
const LIVE_PLAYER = readSource('../src/renderer/src/components/player/LivePlayer.vue')
const STREAM_RETRY = readSource('../src/renderer/src/composables/use-stream-retry.ts')
const INITIALIZE = readSource('../src/renderer/src/components/app/Initialize.vue')
const LIVE_GUARD = readSource('../src/renderer/src/composables/use-live-guard.ts')
const ROOMS = readSource('../src/renderer/src/pages/Rooms.vue')
const MEMBERS = readSource('../src/renderer/src/pages/Members.vue')
const MEMBER_DETAIL = readSource('../src/renderer/src/composables/use-member-detail.ts')
const MEMBER_ACTIONS = readSource('../src/renderer/src/composables/use-member-actions.ts')
const LIVE_DANMAKU = readSource('../src/renderer/src/composables/use-live-danmaku.ts')
const PLAYBACK_DANMAKU = readSource('../src/renderer/src/composables/use-playback-danmaku.ts')
const PREVIEW_IMAGE = readSource('../src/renderer/src/components/ui/PreviewImage.vue')
const ROOM_ALBUM = readSource('../src/renderer/src/components/rooms/RoomAlbum.vue')
const ROOM_DATE_DIALOG = readSource('../src/renderer/src/components/rooms/RoomDateDialog.vue')
const SETTING = readSource('../src/renderer/src/pages/Setting.vue')
const SETTING_MEDIA = readSource('../src/renderer/src/components/setting/SettingMedia.vue')
const APP_CONFIG = readSource('../src/renderer/src/composables/use-app-config.ts')
const POCKET_ACCOUNT = readSource('../src/renderer/src/composables/use-pocket-account.ts')

describe('埋点脚本不得阻塞首屏', () => {
  it('埋点脚本改用 async：defer 的经典脚本会排在 module 之前，域名超时即白屏', () => {
    const tag = INDEX_HTML.match(/<script[^>]*log\.v2ing\.com[^>]*>/)?.[0] ?? ''
    expect(tag).not.toBe('')
    expect(tag).toMatch(/\basync\b/)
    expect(tag).not.toMatch(/\bdefer\b/)
  })

  it('埋点脚本仍关闭自动采集：打开后会把 file:// 安装路径当 URL 上报', () => {
    const tag = INDEX_HTML.match(/<script[^>]*log\.v2ing\.com[^>]*>/)?.[0] ?? ''
    expect(tag).toContain('data-auto-track="false"')
  })
})

describe('直播终态事件一次会话只报一条', () => {
  it('live:end 只有一个上报点（trackLiveEnded），避免各结束路径各发一次', () => {
    const occurrences = LIVE_PLAYER.match(/trackEvent\('live:end'/g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('收到 CLOSELIVE 走统一结束入口：绕过 finishLiveEnded 会让 live:end 的 by 分布失真', () => {
    const closeLiveEnded = LIVE_PLAYER.match(/function closeLiveEnded\(\)[\s\S]*?\n\}/)?.[0] ?? ''
    expect(closeLiveEnded).toContain('finishLiveEnded(\'push\')')
    // 直接 enterLiveEnded 就是漏报的写法
    expect(closeLiveEnded).not.toContain('enterLiveEnded()')
  })

  it('重试耗尽不再单独上报：live:fail 与终态事件重复计数会让失败率无法按会话去重', () => {
    expect(STREAM_RETRY).not.toMatch(/trackEvent\('live:fail'/)
    expect(LIVE_PLAYER).not.toMatch(/trackEvent\('live:fail'/)
  })
})

describe('首启门禁上报 FFmpeg 判定结果', () => {
  it('启动门禁上报判定结果与修复动作', () => {
    expect(INITIALIZE).toContain('ffmpeg:check')
    expect(INITIALIZE).toContain('ffmpeg:fix')
    // 两处 ffmpeg:fix 必须带 at 区分阶段，否则首启与设置页的成功率会混成一个数
    expect(INITIALIZE).toContain('at: \'init\'')
  })

  it('设置页的修复动作复用同一事件，标 at=setting', () => {
    expect(SETTING_MEDIA).toContain('trackEvent(\'ffmpeg:fix\', { action, result, at: \'setting\' })')
    expect(SETTING_MEDIA).toContain('trackFfmpegFix(\'download\', \'ok\')')
    expect(SETTING_MEDIA).toContain('trackFfmpegFix(\'download\', \'fail\')')
    expect(SETTING_MEDIA).toContain('trackFfmpegFix(\'choose\'')
  })

  it('开播被环境拦下时单独计数：否则连点开播与从未点击无法区分', () => {
    expect(LIVE_GUARD).toContain('live:blocked')
  })
})

describe('房间入口与关注要能分清来源', () => {
  it('进房事件都带入口来源：深链（成员卡 / 托盘）与左列点击不能混成一个数', () => {
    const enters = ROOMS.match(/trackEvent\('rooms:enter', \{[^}]*\}\)/g) ?? []
    // 成功与失败两条上报路径都要在
    expect(enters.length).toBeGreaterThanOrEqual(2)
    for (const call of enters)
      // from 可能写成简写（{ starName, from }），只要求出现这个属性名
      expect(call).toMatch(/\bfrom\b/)
  })

  it('深链进房失败单独计数，且不占用每日去重额度', () => {
    // 顺序即语义：先上报失败、再提示；失败分支不能经过 trackRoomEnter（它会消耗当日去重）
    expect(ROOMS).toMatch(/trackEvent\('rooms:enter', \{ from: 'query', result: 'fail' \}\)\r?\n[\t ]*ElMessage\.warning/)
  })

  it('房间页关注/取关上报，并区分口袋关注与本机关注', () => {
    expect(ROOMS).toContain('trackEvent(\'member:follow\', { action, from: \'room\', target, starName')
    // 两个开关各自的失败分支都要带 result
    expect(ROOMS).toContain('trackRoomFollow(willFollow ? \'follow\' : \'unfollow\', \'pocket\', true)')
    expect(ROOMS).toMatch(/trackRoomFollow\('(?:follow|unfollow)', 'local', !ok\)/)
  })

  it('置顶/取消置顶两个入口都上报，区分来源且带房主名 starName', () => {
    expect(ROOMS).toContain('trackEvent(\'room:pin\', { action, from, starName })')
    expect(ROOMS).toContain('onToggleRoomPin(target.room.userId, \'menu\')')
    expect(ROOMS).toContain('onToggleRoomPin(selectedRoom.userId, \'header\')')
    // 页面内只允许经 handler 调 store：绕过它就是一条无埋点的置顶
    expect(ROOMS.match(/toggleRoomPin\(/g) ?? []).toHaveLength(1)
  })

  it('详情抽屉的关注/屏蔽带上页面维度：三处抽屉共用 from=detail', () => {
    expect(MEMBER_DETAIL).toContain('detailPage.value')
    expect(MEMBER_DETAIL).toContain('detailPage.value = from === \'playback\' ? \'playbacks\' : \'lives\'')
    expect(MEMBERS).toContain('toggleFollowMember(m, \'detail\', \'members\')')
    expect(MEMBERS).toContain('toggleBlockMember(m, \'detail\', \'members\')')
  })

  it('member:follow 带成员名 starName：成员页与房间页口径一致', () => {
    expect(MEMBER_ACTIONS).toContain('trackEvent(\'member:follow\', { action: willFollow ? \'follow\' : \'unfollow\', from, starName')
    expect(ROOMS).toContain('trackEvent(\'member:follow\', { action, from: \'room\', target, starName')
  })

  it('详情打开事件带成员名：两个页面级入口都要带，否则看板上所有人混成一堆', () => {
    expect(MEMBER_DETAIL).toMatch(/trackEvent\('member:detail_open', \{ starName: member\.realName \|\| member\.nickname, from \}\)/)
    expect(MEMBERS).toMatch(/trackEvent\('member:detail_open', \{ starName: member\.realName \|\| member\.nickname, from: 'members' \}\)/)
  })
})

describe('弹幕上报要能看清成败与来源', () => {
  it('发弹幕带房主名与结果，且不再保留恒定的 source', () => {
    expect(LIVE_PLAYER).toMatch(/trackEvent\('danmaku:send', \{ starName: realName\.value, result/)
    expect(LIVE_PLAYER).not.toMatch(/trackEvent\('danmaku:send', \{ source:/)
    // 未连接与服务端拒绝两条失败路径都要上报
    expect(LIVE_PLAYER).toContain('trackDanmakuSend(\'fail\', \'not-connected\')')
    expect(LIVE_PLAYER).toContain('trackDanmakuSend(\'fail\', \'error\')')
  })

  it('三个弹幕源的连接结果都有上报：B 站 / 口袋 / 回放', () => {
    expect(LIVE_DANMAKU).toContain('trackDanmakuConnect(\'bili\', \'fail\')')
    expect(LIVE_DANMAKU).toContain('trackDanmakuConnect(\'bili\', \'ok\')')
    expect(LIVE_DANMAKU).toContain('trackDanmakuConnect(\'pocket\', \'fail\')')
    expect(LIVE_DANMAKU).toContain('trackDanmakuConnect(\'pocket\', \'ok\')')
    expect(PLAYBACK_DANMAKU).toContain('source: \'vod\', result: \'fail\'')
    expect(PLAYBACK_DANMAKU).toContain('source: \'vod\', result: \'ok\'')
  })
})

describe('看图事件带房主名', () => {
  it('两个图片入口都上报 starName，且由调用方把房主名透传进来', () => {
    expect(PREVIEW_IMAGE).toContain('trackEvent(\'image:view\', { from, starName: ownerName })')
    expect(ROOM_ALBUM).toContain('starName: props.ownerName')
    // 透传链路：消息流 / 相册 / 精华弹层 / 按日期弹层都要传，否则退化成一个空维度
    expect(ROOMS.match(/:owner-name=/g) ?? []).toHaveLength(2)
    expect(ROOMS).toContain(':room-name="selectedRoom?.nickname ?? \'\'"')
    expect(ROOM_DATE_DIALOG).toContain(':owner-name="roomName"')
  })
})

describe('设置页的四类操作都有上报', () => {
  it('下载目录变更走 setting:change，且不记路径', () => {
    expect(APP_CONFIG).toContain('trackEvent(\'setting:change\', { key: \'downloadDir\', result: \'ok\' })')
    expect(APP_CONFIG).toContain('trackEvent(\'setting:change\', { key: \'downloadDir\', result: \'fail\' })')
    expect(APP_CONFIG).not.toContain('key: \'downloadDir\', path')
  })

  it('播放窗置顶带具体取值与成败', () => {
    expect(SETTING_MEDIA).toContain('key: \'floatTopmost\'')
    expect(SETTING_MEDIA).toContain('result: floatTopmost.value === value ? \'ok\' : \'fail\'')
  })

  it('设置页解除屏蔽 / 清空名单复用 member:block，并标 from=setting', () => {
    expect(SETTING).toContain('action: \'unblock\', from: \'setting\'')
    expect(SETTING).toContain('action: \'unblock_all\'')
    // 两个出口都必须走带埋点的 handler，不能直接绑 store 方法
    expect(SETTING).toContain('@unblock="handleUnblock"')
    expect(SETTING).toContain('@clear-all="handleClearBlocked"')
  })

  it('退出登录有独立事件：登录有 pocket:login，登出不能没有', () => {
    expect(POCKET_ACCOUNT).toContain('trackEvent(\'pocket:logout\', { result: \'ok\' })')
    expect(POCKET_ACCOUNT).toContain('trackEvent(\'pocket:logout\', { result: \'fail\' })')
  })
})
