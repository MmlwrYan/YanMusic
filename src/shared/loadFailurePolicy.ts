/**
 * 界面加载失败的判定策略（S-2，v1.3.0）。
 *
 * 放在 `shared/` 而不是 `main/loadFailureRecovery.ts` 里的原因：后者 import 了
 * `electron`，在 node 下无法加载 —— 而这段判定恰恰是「兜底会不会变成骚扰源」的
 * 关键（子 iframe 失败、导航被新请求打断都不该弹框给用户），必须能**真单测**，
 * 不能只靠源码正则断言（项目在 v1.2.9 已经吃过「守卫没有鉴别力」的亏）。
 */

/** `ERR_ABORTED`：导航被新的导航请求打断（切换路由/窗口、重定向时很常见） */
export const ERR_ABORTED = -3;

/**
 * 这次 `did-fail-load` 是否值得走恢复流程。
 *
 * @param isMainFrame 是否为主框架（子 iframe 失败与用户要看的界面无关，不打扰）
 * @param errorCode   Chromium 错误码
 */
export const isRecoverableLoadFailure = (isMainFrame: boolean, errorCode: number): boolean =>
  isMainFrame && errorCode !== ERR_ABORTED;
