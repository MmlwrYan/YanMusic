import { session, type Session } from 'electron';
import log from './logger';
import {
  buildReportOnlyResponseHeaders,
  isObservableAppPage,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_ONLY_POLICY,
} from '../shared/cspReportOnly';
import { DESKTOP_LYRIC_SESSION_PARTITION } from './networkPolicy';

/**
 * N-02 观测：给应用自身页面（`index.html` / `desktop-lyric.html`）挂上
 * **仅报告** 的 CSP，用来回答「将来若强制 CSP，会打断什么」。
 *
 * ## 只观测，不阻断
 *
 * 下发的是 `Content-Security-Policy-Report-Only`，浏览器只产生
 * `securitypolicyviolation` 事件，**不会阻止任何加载或执行**。本地实测对照：
 * 同一策略作为强制头时内联脚本被拦下（`disposition: enforce`），
 * 作为 Report-Only 头时内联脚本照常执行（`disposition: report`）。
 *
 * ## ⚠️ 关键实现约束：每 session 只能有一个 onHeadersReceived 监听器
 *
 * Electron 的 `webRequest.onHeadersReceived` 在同一个 session 上**后注册者覆盖先注册者**
 * （没有 addListener 语义）。因此这里刻意只在下面两个 session 上注册：
 *   - `defaultSession`：主窗口与 mini 播放器
 *   - `persist:desktop-lyric`：桌面歌词
 * 而 `electronAxiosAdapter` 的 cookie 捕获头监听器注册在 `APP_NETWORK` /
 * `KUGOU_API` 分区上（`electronAxiosAdapter.ts:88`），二者**不重叠**，不会互相覆盖。
 * 后续若要给这几个 session 再加 onHeadersReceived，必须改为链式组合，否则会静默失效。
 *
 * ## 为什么不用 meta 标签
 *
 * CSP 规范只允许 `<meta http-equiv>` 承载**强制**策略；实测把
 * `Content-Security-Policy-Report-Only` 写进 meta：节点存在、内联脚本照常执行、
 * **0 条 violation**（静默失效）。故只能走响应头。`file://` 请求同样会经过
 * `onHeadersReceived`（实测 `responseHeaders` 为 `Content-Type` + `Last-Modified`）。
 */

let installed = false;

const describe = (target: Session) => {
  // 仅用于日志辨识，不参与判定
  return target === session.defaultSession ? 'default' : 'partition';
};

export const installCspObservation = (): void => {
  if (installed) return;
  installed = true;

  const targets: Array<{ label: string; target: Session }> = [
    { label: 'default', target: session.defaultSession },
    { label: 'desktop-lyric', target: session.fromPartition(DESKTOP_LYRIC_SESSION_PARTITION) },
  ];

  let observedPages = 0;

  for (const { label, target } of targets) {
    target.webRequest.onHeadersReceived((details, callback) => {
      if (!isObservableAppPage(details.url)) {
        // 不改动其它响应：`callback({})` 表示沿用原始响应头。
        callback({});
        return;
      }
      observedPages += 1;
      if (observedPages === 1) {
        log.info('[CSP-Observe] Report-Only policy attached', {
          session: label,
          url: details.url,
          header: CSP_REPORT_ONLY_HEADER,
          policy: CSP_REPORT_ONLY_POLICY,
        });
      }
      // ⚠️ 必须只回传最小头集：回传 file:// 的原始头（含 Last-Modified）会让
      // Chromium 以 ERR_FAILED 拒绝响应 → 页面白屏。详见 shared/cspReportOnly.ts。
      callback({ responseHeaders: buildReportOnlyResponseHeaders(details.responseHeaders) });
    });

    log.info('[CSP-Observe] header hook installed', {
      session: label,
      kind: describe(target),
      mode: 'report-only',
    });
  }
};
