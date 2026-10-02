import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeEventLoopStallSummaries,
  parseEventLoopStalls,
} from '../src/main/diagnostics/stallSummary.ts';

/**
 * S-6（v1.3.0）守卫：卡顿摘要解析。
 *
 * ## 背景
 *
 * 诊断包要带「卡顿摘要」，而卡顿记录只在**诊断模式**下由 `eventLoopMonitor` 写入日志
 *（平时不留常驻定时器，这是刻意设计）。因此摘要靠**解析日志**得到 ——
 * 不改动那个模块，也保证「诊断包里的卡顿数」与「用户看到的日志」口径一致。
 *
 * 解析逻辑抽在零依赖模块里，故本文件可直接驱动真行为。
 * 重点覆盖**格式漂移容忍**：日志文案可能随版本调整，过严的正则会让这一项
 * 静默失效（诊断包里少了一项而无人察觉），所以断言刻意覆盖几种措辞变体。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `parseEventLoopStalls` 的 `lags.push(value)` 删掉（即只匹配不收集）→ 用例 1–3 变红。
 */

const line = (lagMs: number) =>
  `[2026-10-02 12:00:00.000] [warn]  [EventLoopMonitor] 主进程事件循环卡顿 ~${lagMs}ms（阈值 100ms）`;

test('S-6：解析单条卡顿记录', () => {
  const summary = parseEventLoopStalls(line(123));
  assert.equal(summary.count, 1);
  assert.equal(summary.maxLagMs, 123);
  assert.deepEqual(summary.recentLagsMs, [123]);
});

test('S-6：多条记录的计数与最大值取全量，最近样本保序', () => {
  const text = [line(150), '一些无关日志', line(320), line(101), line(999)].join('\n');
  const summary = parseEventLoopStalls(text);

  assert.equal(summary.count, 4);
  assert.equal(summary.maxLagMs, 999, '最大值必须取全量，而不是只看最近几个');
  assert.deepEqual(summary.recentLagsMs, [150, 320, 101, 999], '最近样本应保持出现顺序');
});

test('S-6：最近样本上限为 10（避免诊断包被刷屏记录撑大）', () => {
  const text = Array.from({ length: 25 }, (_, i) => line(100 + i)).join('\n');
  const summary = parseEventLoopStalls(text);

  assert.equal(summary.count, 25);
  assert.equal(summary.recentLagsMs.length, 10);
  assert.deepEqual(
    summary.recentLagsMs,
    [115, 116, 117, 118, 119, 120, 121, 122, 123, 124],
    '应保留最后 10 条',
  );
  assert.equal(summary.maxLagMs, 124);
});

test('S-6：无卡顿记录或空输入时为全零（不得抛错）', () => {
  for (const input of ['', '普通日志\n没有任何卡顿记录', '[EventLoopMonitor] 已启动（诊断模式）']) {
    const summary = parseEventLoopStalls(input);
    assert.deepEqual(summary, { count: 0, maxLagMs: 0, recentLagsMs: [] }, `输入：${input}`);
  }
  // 非字符串输入（调用方可能拿到 undefined）也要安全
  assert.doesNotThrow(() => parseEventLoopStalls(undefined as unknown as string));
  assert.deepEqual(parseEventLoopStalls(undefined as unknown as string), {
    count: 0,
    maxLagMs: 0,
    recentLagsMs: [],
  });
});

test('S-6：容忍日志文案措辞变化（骨架稳定即可匹配）', () => {
  // 这几种都是「EventLoopMonitor + 卡顿 + ~Nms」骨架的合理变体。
  // 若将来 eventLoopMonitor 调整措辞，正则仍应命中 —— 否则摘要会静默变空。
  const variants = [
    '[EventLoopMonitor] 主进程事件循环卡顿 ~250ms',
    '[EventLoopMonitor] 事件循环卡顿 ~250ms（阈值 100ms）',
    'prefix [EventLoopMonitor] 卡顿 ~250ms suffix',
    '[EventLoopMonitor] 主进程事件循环卡顿 ~250.5ms',
  ];
  for (const variant of variants) {
    const summary = parseEventLoopStalls(variant);
    assert.equal(summary.count, 1, `应匹配：${variant}`);
    assert.ok(summary.maxLagMs >= 250, `应解析出数值：${variant}`);
  }
});

test('S-6：不得把无关的毫秒数字当作卡顿（避免摘要虚高）', () => {
  const text = [
    '[PlayerEngine] Track loudness applied durationMs=1234',
    '[IPCProfiler] handler "x" 同步占用主线程 ~80ms',
    '[EventLoopMonitor] 已启动（诊断模式），阈值 100ms',
  ].join('\n');
  assert.deepEqual(parseEventLoopStalls(text), { count: 0, maxLagMs: 0, recentLagsMs: [] });
});

test('S-6：多份日志的摘要合并（诊断包会收录多个日志文件）', () => {
  const merged = mergeEventLoopStallSummaries([
    parseEventLoopStalls(line(120)),
    parseEventLoopStalls([line(400), line(130)].join('\n')),
    { count: 0, maxLagMs: 0, recentLagsMs: [] },
  ]);

  assert.equal(merged.count, 3);
  assert.equal(merged.maxLagMs, 400);
  assert.deepEqual(merged.recentLagsMs, [120, 400, 130], '合并后仍按出现顺序保留最近样本');
});
