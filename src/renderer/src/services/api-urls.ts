/**
 * 全部接口地址（无状态常量）。
 *
 * 说明：不用 `class + static` —— ES 模块本身就是单例，class 外壳对纯常量没有任何收益。
 * 保留 `ApiUrls` 命名空间对象，是为了让 `ApiUrls.LIVE_LIST_URL` 这类访问保持不变。
 */
const ApiUrls = {
  OPEN_LIVE_LIST_URL: 'https://pocketapi.48.cn/live/api/v1/live/getOpenLiveList',
  OPEN_LIVE_URL: 'https://pocketapi.48.cn/live/api/v1/live/getOpenLiveOne',
  LIVE_LIST_URL: 'https://pocketapi.48.cn/live/api/v1/live/getLiveList',
  LIVE_ONE_URL: 'https://pocketapi.48.cn/live/api/v1/live/getLiveOne',
  MUSIC_LIST_URL: 'https://www.cgt48.com/json/music_snh.json',
  B50_ALBUMS_URL: 'https://b50.ckg48.com/resource/json/albums.json',
  B50_SONGS_URL: 'https://b50.ckg48.com/resource/json/songs.json',

  UPDATE_INFO_URL: 'https://pocketapi.48.cn/user/api/v1/client/update/group_team_star',
  SET_COOKIE_URL: 'https://live.48.cn/Server/do_ajax_setcookie',

  MESSAGE_BOX_URL: 'https://pocketapi.48.cn/message/api/v1/user/message/list',
  MESSAGE_INFO_URL: 'https://pocketapi.48.cn/message/api/v1/user/message/info',

  MOBILE_LOGIN_URL: 'https://pocketapi.48.cn/user/api/v1/login/app/mobile',
  VERIFY_CODE_LOGIN_URL: 'https://pocketapi.48.cn/user/api/v1/login/app/mobile/code',
  SEND_SMS_URL: 'https://pocketapi.48.cn/user/api/v1/sms/send2',

  USER_INFO_URL: 'https://pocketapi.48.cn/user/api/v1/user/info/reload',

  JUJU_LIST_URL: 'https://pocketapi.48.cn/im/api/v1/conversation/page',
  JUJU_SOURCE_URL: 'https://pocketapi.48.cn/im/api/v1/im/room/info/type/source',
  JUJU_OWNER_URL: 'https://pocketapi.48.cn/im/api/v1/chatroom/msg/list/homeowner',
  JUJU_ALL_URL: 'https://pocketapi.48.cn/im/api/v1/chatroom/msg/list/all',
  IM_USER_INFO: 'https://pocketapi.48.cn/im/api/v1/im/userinfo',

  ADD_SINGLE_ATTENTION_URL: 'https://pocketapi.48.cn/user/api/v1/friendships/friends/add',
  REMOVE_SINGLE_ATTENTION_URL: 'https://pocketapi.48.cn/user/api/v1/friendships/friends/remove',
  FOLLOW_MEMBERS_URL: 'https://pocketapi.48.cn/user/api/v1/friendships/friends',

  CHECK_IN_URL: 'https://pocketapi.48.cn/user/api/v1/checkin',

  TRIP_LIST_URL: 'https://pocketapi.48.cn/trip/api/trip/v1/list',
}

export default ApiUrls
