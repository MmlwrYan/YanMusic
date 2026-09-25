/**
 * N-02 观测：为应用自身页面下发**仅报告（Report-Only）**的 CSP。
 *
 * 设计红线：**只观测，不阻断**。Report-Only 策略即使写得很严，浏览器也只产生
 * `securitypolicyviolation` 事件，不会阻止任何资源加载或内联脚本执行 ——
 * 这一点由本地 Electron 实测确认（见下方 `CSP_OBSERVATION_NOTES`）。
 *
 * 为什么必须走**响应头**而不是 `<meta http-equiv>`：
 * CSP 规范只允许 meta 承载**强制**策略；`Content-Security-Policy-Report-Only`
 * 写在 meta 里会被 Chromium **完全忽略**。实测（Electron 43 / Chromium 150）
 * 页面里放 meta：meta 节点存在、内联脚本照常执行、**0 条 violation** —— 即静默失效。
 */

/** 观测用策略：贴近「将来可能强制」的形态，但仅用于报告。 */
export const CSP_REPORT_ONLY_POLICY = [
  "default-src 'self'",
  // 渲染层与第三方组件存在内联脚本 / 动态求值；保持与既有 plugin-window.html 同级的放宽，
  // 避免观测被大量已知噪音淹没。
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // style-src **有意取严格值**：本项观测的核心问题正是「强制 CSP 后是否会因内联样式白屏」
  // （审计记录：渲染层有 154 处 `:style=` 绑定 + 24 处 `setProperty`）。Report-Only
  // 不阻断，因此这里取严格值只会「多出报告」，是回答该问题所必需的数据。
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
].join('; ');

export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

/** 强制策略头名。本模块**任何情况下都不得**产出它（否则就从观测变成了强制）。 */
export const CSP_ENFORCING_HEADER = 'Content-Security-Policy';

/** 需要观测的应用自身页面（N-02 指出的两个缺 CSP 的页面）。 */
const OBSERVED_PAGES = ['/index.html', '/desktop-lyric.html'];

/**
 * 是否为本模块要观测的页面。
 *
 * 只认 `file://`（打包后应用自身的加载方式）。`plugin-window.html` 已有强制 CSP，
 * 不在观测范围内；http(s) 资源也不在此列（本观测针对的是页面文档本身的策略）。
 */
export const isObservableAppPage = (url: string): boolean => {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  const pathname = url.split('#')[0].split('?')[0];
  return OBSERVED_PAGES.some((page) => pathname.endsWith(page));
};

const findHeaderValue = (
  headers: Record<string, string | string[]> | undefined,
  target: string,
): string | string[] | undefined => {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === target);
  return key ? headers[key] : undefined;
};

/**
 * 构造用于**替换**的响应头集合。
 *
 * ⚠️ 必须只回传「最小头集」。本地实测（Electron 43 / Chromium 150）：
 * 对 `file://` 请求把原始头整体回传（含 `Last-Modified`）会让 Chromium 以
 * `ERR_FAILED (-2)` 拒绝该响应 —— **页面直接加载失败（白屏）**；只回传
 * `Content-Type` + 目标 CSP 头则加载正常。因此这里刻意只保留 `Content-Type`，
 * 并由 `tests/csp-report-only.test.ts` 把该约束固化为回归守卫。
 */
export const buildReportOnlyResponseHeaders = (
  original: Record<string, string | string[]> | undefined,
): Record<string, string[]> => {
  const rawContentType = findHeaderValue(original, 'content-type');
  const contentType = Array.isArray(rawContentType)
    ? rawContentType
    : rawContentType
      ? [rawContentType]
      : ['text/html'];

  // 注意：键名与强制策略头不同，二者不会互相覆盖；本对象绝不含 CSP_ENFORCING_HEADER。
  return {
    'Content-Type': contentType,
    [CSP_REPORT_ONLY_HEADER]: [CSP_REPORT_ONLY_POLICY],
  };
};

export interface CspViolationInput {
  readonly violatedDirective?: string;
  readonly effectiveDirective?: string;
  readonly blockedURI?: string;
  readonly disposition?: string;
  readonly sourceFile?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly sample?: string;
}

export interface CspViolationRecord {
  readonly directive: string;
  readonly blocked: string;
  readonly disposition: string;
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly sample: string;
}

const MAX_URL = 200;
const MAX_SAMPLE = 80;

/** 去掉查询串与 fragment：URL 里可能带令牌 / 签名参数，日志不应留存。 */
const redactUrl = (value: string): string => {
  const text = String(value ?? '');
  if (!text) return '(inline)';
  const stripped = text.split('#')[0].split('?')[0];
  return stripped.length > MAX_URL ? `${stripped.slice(0, MAX_URL)}…` : stripped;
};

const clampText = (value: unknown, max: number): string => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const toFiniteNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/** 把浏览器给出的 violation 事件规范化成稳定的日志载荷（脱敏 + 截断）。 */
export const normalizeCspViolation = (input: CspViolationInput): CspViolationRecord => ({
  directive: clampText(input.violatedDirective || input.effectiveDirective || '(unknown)', 64),
  blocked: redactUrl(String(input.blockedURI ?? '')),
  disposition: clampText(input.disposition || 'report', 16),
  source: redactUrl(String(input.sourceFile ?? '')),
  line: toFiniteNumber(input.lineNumber),
  column: toFiniteNumber(input.columnNumber),
  sample: clampText(input.sample, MAX_SAMPLE),
});

export interface ViolationDeduper {
  /** 记录一条；返回该键是否为首次出现以及累计次数 */
  add: (record: CspViolationRecord) => { first: boolean; count: number };
  /** 去重后的汇总（按次数降序） */
  summary: () => Array<{ key: string; count: number }>;
  /** 已记录的唯一键数量 */
  size: () => number;
}

const keyOf = (r: CspViolationRecord) => `${r.directive}|${r.blocked}|${r.source}:${r.line}`;

/**
 * 去重器：同一位置的内联样式违规在一次会话里会出现成千上万次（154 处绑定 × 每次渲染），
 * 必须去重并计数，否则日志会被淹没。超过 maxEntries 后只累加计数、不再新增键，
 * 并把这部分计入 `overflow`（由调用方决定如何提示）。
 */
export const createViolationDeduper = (maxEntries = 200): ViolationDeduper => {
  const counts = new Map<string, number>();
  const limit = Math.max(1, Math.floor(maxEntries));

  return {
    add: (record) => {
      const key = keyOf(record);
      const existing = counts.get(key);
      if (existing !== undefined) {
        counts.set(key, existing + 1);
        return { first: false, count: existing + 1 };
      }
      if (counts.size >= limit) {
        const overflowKey = '(overflow)';
        const current = counts.get(overflowKey) ?? 0;
        counts.set(overflowKey, current + 1);
        return { first: false, count: current + 1 };
      }
      counts.set(key, 1);
      return { first: true, count: 1 };
    },
    summary: () =>
      [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
    size: () => counts.size,
  };
};

/** 观测机制的实现注记（供后续维护者与 v1.3.0 参考）。 */
export const CSP_OBSERVATION_NOTES = [
  'Delivery: response header via session.webRequest.onHeadersReceived (file:// included).',
  'meta http-equiv Report-Only is ignored by Chromium (measured: 0 violations).',
  'Return ONLY Content-Type (+ the report-only header): echoing file:// origin headers throws ERR_FAILED.',
  'Report-Only never blocks: measured inline script still executed, disposition was "report".',
].join(' | ');
