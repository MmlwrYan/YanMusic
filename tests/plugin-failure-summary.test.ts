import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  FAILURE_SUMMARY_MAX_CHARS,
  buildFailureSummary,
} from '../src/renderer/views/plugins/pluginFailureSummary.ts';

/**
 * 插件卡片内联故障摘要（V4-18，v1.4.0）。
 *
 * 背景（运行时实测，2026-10-14）：`water-lyrics` 启用失败后，卡片上只有状态徽标
 * 「出错」/「异常」二字。**完整错误其实一直都有**（详情弹窗里连调用栈都有），
 * 但要点开右侧一个**不带文字的小三角图标**才看得到 —— 属「信息不易发现」，
 * 不是「信息丢失」。本项把摘要内联到卡片上。
 *
 * 反向验证（见 §「变异自检」）：把 `buildFailureSummary` 改成恒返回空串
 * → 本文件的用例必须变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 运行时实测抓到的真实错误原文（前半段）。 */
const REAL_ERROR = "Cannot read properties of undefined (reading 'register')";

test('V4-18：真实错误原文原样成为摘要', () => {
  assert.equal(buildFailureSummary(REAL_ERROR), REAL_ERROR);
});

test('V4-18：多行堆栈被压成单行（否则会撑破卡片）', () => {
  const multi = `TypeError: ${REAL_ERROR}\n    at Module.activate (yan-plugin:water-lyrics:550:21)\n    at Bt (runtime.js:3:5613)`;
  const summary = buildFailureSummary(multi);
  assert.ok(!summary.includes('\n'), '摘要不得含换行');
  assert.ok(summary.startsWith('TypeError:'), '应保留开头，便于一眼看出错误类型');
  assert.ok(summary.includes('water-lyrics:550'), '应保留最有定位价值的那一帧');
});

test('V4-18：连续空白 / 制表符被收敛为单个空格', () => {
  assert.equal(buildFailureSummary('a\t\t  b\n\n   c'), 'a b c');
});

test('V4-18：首尾空白被去掉', () => {
  assert.equal(buildFailureSummary('   spaced   '), 'spaced');
});

test('V4-18：超长消息被截断并补省略号，且长度受控', () => {
  const long = 'x'.repeat(FAILURE_SUMMARY_MAX_CHARS + 50);
  const summary = buildFailureSummary(long);
  assert.equal(summary.length, FAILURE_SUMMARY_MAX_CHARS + 1, '截断后长度应为上限 + 省略号');
  assert.ok(summary.endsWith('…'), '截断必须给出省略号，不能让用户以为是完整消息');
});

test('V4-18：恰好在上限内的消息不截断', () => {
  const exact = 'y'.repeat(FAILURE_SUMMARY_MAX_CHARS);
  assert.equal(buildFailureSummary(exact), exact);
  assert.ok(!buildFailureSummary(exact).endsWith('…'));
});

test('V4-18：空值 / 非字符串 / 全空白一律返回空串（调用方据此不渲染该行）', () => {
  for (const value of ['', '   ', '\n\t ', undefined, null, 42, {}, []]) {
    assert.equal(buildFailureSummary(value), '', `${JSON.stringify(value)} 应产出空串`);
  }
});

test('V4-18：自定义上限生效；非法上限退化为不截断', () => {
  assert.equal(buildFailureSummary('abcdef', 3), 'abc…');
  assert.equal(buildFailureSummary('abcdef', 0), 'abcdef');
  assert.equal(buildFailureSummary('abcdef', -1), 'abcdef');
  assert.equal(buildFailureSummary('abcdef', Number.NaN), 'abcdef');
});

/**
 * 接线守卫：卡片必须**真的**用上摘要，且只在「当前故障」时显示。
 *
 * ⚠️ 只断言「`buildFailureSummary` 出现在文件里」是**假守卫**（v1.3.5 的教训：
 * 同一函数内多处出现会让 `includes` 恒真）。这里断言的是：
 *   ① 模板里存在渲染该摘要的节点，且受 `failureSummary` 控制；
 *   ② computed 的定义里同时出现 `hasCurrentFailure` 与 `buildFailureSummary`。
 */
test('V4-18：卡片模板与 computed 都已接线（双向锚定，防假绿）', () => {
  const card = read('src/renderer/views/plugins/InstalledPluginCard.vue');

  assert.ok(card.includes('v-if="failureSummary"'), '模板里必须有受 failureSummary 控制的渲染节点');
  assert.ok(
    card.includes('{{ failureSummary }}'),
    '该节点必须真的输出摘要文本，而不是只留一个空容器',
  );

  // 定位 computed 定义体，只在函数体内断言（避免同文件其它位置干扰）
  const start = card.indexOf('const failureSummary = computed(');
  assert.ok(start >= 0, '必须存在 failureSummary 这个 computed');
  const end = card.indexOf('\n);', start);
  assert.ok(end > start, 'computed 定义体必须能定位到结尾');
  const body = card.slice(start, end);

  assert.ok(body.includes('hasCurrentFailure'), '只在「当前故障」时显示，历史故障不占卡片空间');
  assert.ok(body.includes('buildFailureSummary'), '必须复用零依赖纯函数，而不是内联一份实现');
});

/**
 * 「不得残留旧写法」：修复前的卡片在错误块里**只**渲染兼容性消息，
 * 没有任何摘要节点。这里断言摘要节点与兼容性节点**是两个独立的块** ——
 * 否则兼容性提示会被摘要挤掉（两者语义不同：前者是行动依据，后者是故障线索）。
 */
test('V4-18：摘要块与兼容性提示块相互独立（不得合并成一个 v-if）', () => {
  const card = read('src/renderer/views/plugins/InstalledPluginCard.vue');
  assert.ok(
    card.includes('v-if="compatibilityMessage"'),
    '兼容性提示必须保留（它是用户采取行动的依据）',
  );
  assert.ok(card.includes('v-if="failureSummary"'), '摘要必须有自己的条件分支');
});
