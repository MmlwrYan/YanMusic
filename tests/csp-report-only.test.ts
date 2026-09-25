import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildReportOnlyResponseHeaders,
  createViolationDeduper,
  CSP_ENFORCING_HEADER,
  CSP_REPORT_ONLY_HEADER,
  CSP_REPORT_ONLY_POLICY,
  isObservableAppPage,
  normalizeCspViolation,
} from '../src/shared/cspReportOnly.ts';

/**
 * N-02 观测机制的守卫。
 *
 * 背景：`index.html` / `desktop-lyric.html` 此前没有 CSP。直接强制 CSP 有白屏风险
 * （渲染层有 154 处 `:style=` 绑定），因此 v1.2.3 只做**观测**：以
 * `Content-Security-Policy-Report-Only` 下发，浏览器只报告不阻断。
 *
 * 本文件的每一条断言都对应一个实测得到的事实，防止后续改动把「观测」变成「强制」，
 * 或重新踩回已经踩过的坑：
 *   1. meta 形式的 Report-Only 被 Chromium 静默忽略（实测 0 条 violation）→ 只能走响应头；
 *   2. 对 `file://` 回传原始响应头（含 Last-Modified）会让 Chromium 以
 *      `ERR_FAILED (-2)` 拒绝响应 → 页面白屏。必须只回传最小头集。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const headerKeys = (headers: Record<string, string[]>) =>
  Object.keys(headers).map((k) => k.toLowerCase());

test('下发的必须是 Report-Only，任何情况下都不得产出强制 CSP 头', () => {
  const cases: Array<Record<string, string | string[]> | undefined> = [
    undefined,
    {},
    { 'Content-Type': ['text/html'] },
    { 'content-type': 'text/html' },
    { 'Content-Type': ['text/html'], 'Last-Modified': ['Wed, 01 Jan 2025 00:00:00 GMT'] },
    { 'Content-Security-Policy': ["default-src 'none'"] },
  ];
  for (const input of cases) {
    const out = buildReportOnlyResponseHeaders(input);
    assert.ok(
      out[CSP_REPORT_ONLY_HEADER],
      `必须带 ${CSP_REPORT_ONLY_HEADER}：${JSON.stringify(input)}`,
    );
    // 关键：不允许出现强制策略头（否则就从「观测」变成了「强制」）
    for (const key of headerKeys(out)) {
      assert.notEqual(
        key,
        CSP_ENFORCING_HEADER.toLowerCase(),
        `不得产出强制 CSP 头（会把观测变成强制）：${JSON.stringify(out)}`,
      );
    }
    const serialized = JSON.stringify(out);
    assert.ok(
      !serialized.includes('"Content-Security-Policy"') &&
        !serialized.includes('"content-security-policy"'),
      '序列化结果里也不得出现强制 CSP 头名',
    );
  }
});

test('回归守卫：只回传最小头集，禁止透传原始响应头（否则 file:// 会 ERR_FAILED 白屏）', () => {
  const original = {
    'Content-Type': ['text/html'],
    'Last-Modified': ['Fri, 25 Sep 2026 05:29:14 GMT'],
    ETag: ['"abc"'],
  };
  const out = buildReportOnlyResponseHeaders(original);
  const keys = headerKeys(out).sort();
  assert.deepEqual(
    keys,
    ['content-security-policy-report-only', 'content-type'],
    `只允许 Content-Type 与 Report-Only 两个键，实际：${JSON.stringify(keys)}`,
  );
  assert.ok(
    !('last-modified' in Object.fromEntries(keys.map((k) => [k, true]))),
    '不得透传 Last-Modified',
  );
});

test('保留原始 Content-Type（键名大小写不敏感），缺失时兜底 text/html', () => {
  assert.deepEqual(
    buildReportOnlyResponseHeaders({ 'content-type': ['text/html; charset=utf-8'] })[
      'Content-Type'
    ],
    ['text/html; charset=utf-8'],
  );
  assert.deepEqual(
    buildReportOnlyResponseHeaders({ 'Content-Type': 'text/html' })['Content-Type'],
    ['text/html'],
  );
  assert.deepEqual(buildReportOnlyResponseHeaders(undefined)['Content-Type'], ['text/html']);
  assert.deepEqual(buildReportOnlyResponseHeaders({})['Content-Type'], ['text/html']);
});

test('只观测应用自身的两个页面，排除已有强制 CSP 的插件窗口与 http(s)', () => {
  assert.equal(isObservableAppPage('file:///C:/app/dist/index.html'), true);
  assert.equal(isObservableAppPage('file:///C:/app/dist/desktop-lyric.html'), true);
  assert.equal(isObservableAppPage('file:///C:/app/dist/index.html?v=1#x'), true);
  assert.equal(
    isObservableAppPage('file:///Applications/X.app/Contents/Resources/app.asar/dist/index.html'),
    true,
  );

  assert.equal(
    isObservableAppPage('file:///C:/app/plugin-window.html'),
    false,
    '插件窗口已有强制 CSP，不在观测范围',
  );
  assert.equal(isObservableAppPage('https://example.com/index.html'), false);
  assert.equal(isObservableAppPage('http://localhost:5173/index.html'), false);
  assert.equal(isObservableAppPage('file:///C:/app/dist/assets/main.js'), false);
  assert.equal(isObservableAppPage(''), false);
});

test('策略内容：不启用外部上报端点（不新增监听端口），并在关键维度上可观测', () => {
  assert.ok(CSP_REPORT_ONLY_POLICY.includes("default-src 'self'"), '应有 default-src 兜底');
  assert.ok(
    CSP_REPORT_ONLY_POLICY.includes("style-src 'self'"),
    'style-src 需取严格值，否则观测不到唯一真正决定「强制后是否白屏」的内联样式违规',
  );
  assert.ok(!/report-(uri|to)/.test(CSP_REPORT_ONLY_POLICY), '不得启用外部上报端点');
  assert.ok(!CSP_REPORT_ONLY_POLICY.includes('*'), '不得使用通配符放开来源');
});

test('violation 规范化：脱敏查询串与 fragment、截断超长字段、缺字段兜底', () => {
  const record = normalizeCspViolation({
    violatedDirective: "style-src 'self'",
    blockedURI: 'https://cdn.example.com/a.css?token=secret#frag',
    disposition: 'report',
    sourceFile: 'file:///C:/app/dist/index.html?x=1',
    lineNumber: 12.9,
    columnNumber: -3,
    sample: 'x'.repeat(500),
  });
  assert.equal(record.blocked, 'https://cdn.example.com/a.css', '必须去掉查询串（可能含令牌）');
  assert.equal(record.source, 'file:///C:/app/dist/index.html');
  assert.equal(record.line, 12);
  assert.equal(record.column, 0, '负数应兜底为 0');
  assert.equal(record.sample.length, 81, '样本需截断到 80 字符 + 省略号');
  assert.equal(record.disposition, 'report');

  const empty = normalizeCspViolation({});
  assert.equal(empty.directive, '(unknown)');
  assert.equal(empty.blocked, '(inline)');
  assert.equal(empty.disposition, 'report');
  assert.equal(empty.line, 0);
});

test('去重器：同键累加计数、不同键独立、超上限归入 overflow', () => {
  const deduper = createViolationDeduper(3);
  const rec = (line: number) =>
    normalizeCspViolation({
      violatedDirective: "style-src 'self'",
      blockedURI: 'inline',
      lineNumber: line,
    });

  assert.deepEqual(deduper.add(rec(1)), { first: true, count: 1 });
  assert.deepEqual(deduper.add(rec(1)), { first: false, count: 2 });
  assert.deepEqual(deduper.add(rec(1)), { first: false, count: 3 });
  assert.equal(deduper.add(rec(2)).first, true, '不同键应独立');
  assert.equal(deduper.add(rec(3)).first, true);
  // 已达上限 3：新键归入 overflow，不再新增键
  const overflow = deduper.add(rec(4));
  assert.equal(overflow.first, false);
  assert.ok(deduper.size() <= 4, `键数不得超过上限+overflow，实际 ${deduper.size()}`);
  const summary = deduper.summary();
  assert.equal(summary[0].key.includes('style-src'), true);
  assert.equal(summary[0].count, 3, '按次数降序，最高为 3 次');
  assert.ok(
    summary.some((s) => s.key === '(overflow)'),
    '超上限的新键应计入 overflow',
  );
});

test('接线守卫：主进程与两个渲染入口都已安装，且不得新增 IPC 通道', () => {
  const appSource = read('src/main/app.ts');
  assert.ok(/installCspObservation\(\)/.test(appSource), 'app.ts 必须调用 installCspObservation()');
  assert.ok(
    appSource.indexOf('installCspObservation()') < appSource.indexOf('createWindow('),
    '必须在创建窗口之前安装，否则首个文档拿不到策略头',
  );

  const observation = read('src/main/cspObservation.ts');
  assert.ok(observation.includes('session.defaultSession'), '必须覆盖主窗口所用的 defaultSession');
  assert.ok(
    observation.includes('DESKTOP_LYRIC_SESSION_PARTITION'),
    '必须覆盖桌面歌词所用的分区 session',
  );
  // 每 session 只能有一个 onHeadersReceived：注册到这两个分区会覆盖 axios 的 cookie 捕获
  assert.ok(
    !observation.includes('APP_NETWORK_SESSION_PARTITION') &&
      !observation.includes('KUGOU_API_SESSION_PARTITION'),
    '不得在这些分区上注册 onHeadersReceived（会覆盖 electronAxiosAdapter 的 cookie 捕获监听器）',
  );

  for (const entry of ['src/renderer/main.ts', 'src/desktop-lyric/main.ts']) {
    assert.ok(
      read(entry).includes('installCspViolationReporter()'),
      `${entry} 必须安装 CSP 违规收集器`,
    );
  }

  // 复用既有 logger（经 electron-log 落盘），不新增通道
  for (const file of [
    'src/main/cspObservation.ts',
    'src/renderer/utils/cspViolationReporter.ts',
    'src/shared/cspReportOnly.ts',
  ]) {
    const source = read(file);
    assert.ok(!/ipcMain\.(handle|on)\(/.test(source), `${file} 不应新增 ipcMain handler`);
    assert.ok(!/ipcRenderer\.(invoke|send)\(/.test(source), `${file} 不应新增 ipcRenderer 调用`);
  }
});

test('观测注记存在：把三条实测结论固定在代码里，避免后来者重踩', () => {
  assert.ok(CSP_OBSERVATION_NOTES_CHECK(), '注记常量应存在并说明 meta 失效与最小头集约束');
});

// 局部再导出检查（避免在断言里直接依赖常量名拼写）
function CSP_OBSERVATION_NOTES_CHECK(): boolean {
  const notes = read('src/shared/cspReportOnly.ts');
  return (
    notes.includes('CSP_OBSERVATION_NOTES') &&
    notes.includes('meta http-equiv Report-Only is ignored') &&
    notes.includes('ERR_FAILED')
  );
}
