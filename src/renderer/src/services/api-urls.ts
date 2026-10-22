/**
 * 站点请求的接口地址（渲染层 `Apis.*` 使用，无状态常量）。
 *
 * pocketapi 域地址统一由 `src/common/pocket-api-urls.ts` 提供（与主进程同源，说明见该文件）；
 * 成员名单（h5.48.cn）也在那里——主进程网络诊断要探同一组地址；
 * 这里只剩曲库静态 JSON（cgt48.com）一条其它域名的地址。
 *
 * 登录 / 发码 / 关注 / 签到 / 行程 / 消息 / IM 会话等地址在主进程（`main/pocket48/pocket-auth.ts`）。
 *
 * 注意：本文件被 `tsconfig.node.json` 的 include 显式收录，同属 node / web 两个工程，
 * 引用 `src/common` 必须用 `@common/...`（两个 tsconfig 都配了同名 paths）。
 */
import { ALL_MEMBER_SNAPSHOT_URL, ALL_MEMBER_URL, LIVE_LIST_URL, LIVE_ONE_URL, OPEN_LIVE_LIST_URL, OPEN_LIVE_URL, UPDATE_INFO_URL } from '@common/pocket-api-urls'

const ApiUrls = {
  // 直播 / 回放：getLiveList 为在播列表，getOpenLiveList 为公演排期
  LIVE_LIST_URL,
  LIVE_ONE_URL,
  OPEN_LIVE_LIST_URL,
  OPEN_LIVE_URL,

  // 成员数据同步（starInfo / teamInfo 等分节的全量拉取）
  UPDATE_INFO_URL,

  // 成员名单：静态快照为主、jsonp 接口为备（两者同构，见 apis.ts 的 ALL_MEMBER_SOURCES）
  ALL_MEMBER_SNAPSHOT_URL,
  ALL_MEMBER_URL,
  MUSIC_LIST_URL: 'https://www.cgt48.com/json/music_snh.json',
}

export default ApiUrls
