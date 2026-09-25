import {
  createViolationDeduper,
  normalizeCspViolation,
  type CspViolationInput,
} from '../../shared/cspReportOnly';
import logger from './logger';

/**
 * N-02 观测：在渲染层收集 CSP 违规并写入日志。
 *
 * 策略由主进程以 `Content-Security-Policy-Report-Only` 响应头下发（见
 * `src/main/cspObservation.ts`），浏览器只**报告**不阻断，因此本模块纯观测。
 *
 * 为什么不设 `report-uri` 指向本地端点：那需要在主进程额外开一个 HTTP 监听端口，
 * 对「只观测」的目标而言是净增攻击面。改用 `securitypolicyviolation` DOM 事件 +
 * 既有的渲染层 logger（经 electron-log 落到应用日志文件），零新增端口、零新增 IPC 通道。
 *
 * 去重是必需的：同一处内联样式违规在每次渲染都会重复触发（审计记录渲染层有
 * 154 处 `:style=` 绑定），不去重会立刻淹没日志。
 */

let installed = false;

export const installCspViolationReporter = (): void => {
  if (installed) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  installed = true;

  const deduper = createViolationDeduper(200);

  document.addEventListener('securitypolicyviolation', (event) => {
    const record = normalizeCspViolation(event as unknown as CspViolationInput);
    const { first, count } = deduper.add(record);
    // 只记首次出现；重复次数由汇总体现，避免刷屏
    if (!first) return;
    logger.warn('CSP-Observe', {
      kind: 'violation',
      directive: record.directive,
      blocked: record.blocked,
      disposition: record.disposition,
      source: record.source,
      line: record.line,
      column: record.column,
      sample: record.sample,
      occurrences: count,
    });
  });

  // 页面隐藏时输出一次去重汇总：这是 v1.3.0 决定「哪些内联用法必须先治理」的输入
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    const summary = deduper.summary();
    if (summary.length === 0) return;
    logger.info('CSP-Observe', {
      kind: 'summary',
      uniqueKeys: deduper.size(),
      top: summary.slice(0, 20),
    });
  });
};
