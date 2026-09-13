import request from '@/utils/request';

/**
 * 注册设备获取 dfid/mid
 */
export function registerDevice() {
  return request.get('/register/dev', {
    headers: {
      'X-Skip-Auth': '1',
    },
  });
}

/**
 * 获取二维码 Key (酷狗扫码)
 */
export function getLoginQrKey() {
  return request.get('/login/qr/key');
}

/**
 * 创建二维码 (酷狗扫码)
 */
export function createLoginQr(key: string) {
  return request.get('/login/qr/create', {
    params: { key, qrimg: 'true' },
  });
}

/**
 * 检查二维码状态 (酷狗扫码)
 */
export function checkLoginQr(key: string) {
  return request.get('/login/qr/check', {
    params: { key },
  });
}

/**
 * 发送手机验证码
 */
export function sendSmsCode(mobile: string) {
  return request.get('/captcha/sent', {
    params: { mobile },
  });
}

/**
 * 手机验证码登录
 */
export function loginBySms(mobile: string, code: string) {
  return request.get('/login/cellphone', {
    params: { mobile, code },
  });
}

/**
 * 用户名/密码登录
 */
export function loginByPassword(username: string, password: string) {
  return request.get('/login', {
    params: { username, password },
  });
}

/**
 * 创建微信登录二维码
 */
export function createWxLogin() {
  return request.get('/login/wx/create');
}

/**
 * 检查微信登录状态
 */
export function checkWxLogin(uuid: string, timestamp?: number) {
  return request.get('/login/wx/check', {
    params: { uuid, timestamp },
  });
}

/**
 * 开放平台登录 (微信登录最终步骤)
 */
export function loginByOpenPlat(code: string) {
  return request.get('/login/openplat', {
    params: { code, plat: 2 },
  });
}

/**
 * 获取用户信息
 */
export function getUserDetail() {
  return request.get('/user/detail');
}

/**
 * 获取用户 VIP 信息
 */
export function getUserVipDetail() {
  return request.get('/user/vip/detail');
}

/**
 * 领取每日畅听会员
 */
export function claimDayVip(day: string) {
  return request.get('/youth/day/vip', {
    params: { receive_day: day },
  });
}

/**
 * 升级每日概念会员
 */
export function upgradeDayVip() {
  return request.get('/youth/day/vip/upgrade');
}

/**
 * 获取 VIP 领取记录
 */
export function getVipMonthRecord() {
  return request.get('/youth/month/vip/record');
}

/**
 * 获取播放历史
 */
export function getUserHistory(bp?: string) {
  return request.get('/user/history', {
    params: { bp },
  });
}

/**
 * 获取服务器时间
 */
export function getServerNow() {
  return request.get('/server/now');
}

/**
 * 上传播放历史
 * @param mixSongId 歌曲 mixSongId
 */
export function uploadPlayHistory(mxid: number | string) {
  return request.get('/playhistory/upload', {
    params: {
      mxid,
    },
  });
}

/**
 * 上报听歌时长（用于等级积分，需登录）
 * 对接 /user/grade/info 的上报模式：
 *  - d_sec 上报基准秒数，由调用方与服务端累计值对齐
 *  - diff_sec 本次新增秒数
 *  - protocol 可选，强制协议 v2（lite）/ v4（标准版）
 * @param options.dSec 本地累计听歌秒数
 * @param options.diffSec 本次新增秒数
 * @param options.protocol 可选，强制协议
 */
export function reportListenTime(options: {
  dSec: number;
  diffSec: number;
  protocol?: 'v2' | 'v4';
}) {
  return request.get('/user/grade/info', {
    params: {
      d_sec: options.dSec,
      diff_sec: options.diffSec,
      ...(options.protocol ? { protocol: options.protocol } : {}),
    },
  });
}

/**
 * 查询听歌等级信息（累计听歌时长/等级/积分，需登录）
 * 对接 /user/grade/info 的查询模式
 */
export function getUserGradeInfo() {
  return request.get('/user/grade/info');
}

/**
 * 获取用户云盘
 */
export function getUserCloud(page = 1, pagesize = 30) {
  return request.get('/user/cloud', {
    params: { page, pagesize },
  });
}

/**
 * 获取用户关注歌手
 */
export function getUserFollow() {
  return request.get('/user/follow');
}

/**
 * 获取用户收藏的视频
 */
export function getUserVideoCollect(page = 1, pagesize = 30) {
  return request.get('/user/video/collect', {
    params: { page, pagesize },
  });
}
