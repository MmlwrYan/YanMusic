import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  KNOWN_PLUGIN_CAPABILITIES,
  describeUnknownCapabilities,
  findUnknownCapabilityKeys,
  isKnownPluginCapability,
} from '../src/shared/plugin-capabilities.ts';

/**
 * 插件 manifest `capabilities` 白名单（V4-19，v1.4.0）。
 *
 * 背景（运行时实测，2026-10-14）：官方源的 `water-lyrics` 声明了
 * `capabilities.lyricsPage: true` —— 而 `lyricsPage` 在本项目源码里 **0 命中**。
 * 它对应的 `ctx.ui.lyricsPage` 不存在，于是插件装完、启用、然后运行时报 `TypeError`，
 * 界面只显示「出错」两个字。修复前 `validateManifestCapabilities()` 只对 11 个已知键
 * 做类型校验，**对未知键既不校验也不告警**，所以这件事一路上没有任何提示。
 *
 * 本测试守两件事：
 *   ① 纯函数判定的真行为（可鉴别）；
 *   ② `KNOWN_PLUGIN_CAPABILITIES` 与 `descriptor.ts` 的校验序列**完全一致**
 *      —— 防止「加了新 capability 却忘了加进白名单」而把它变成未知键、产生假告警。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 截取 `descriptor.ts` 里 `validateManifestCapabilities()` 的函数体（到其后第一个 `\n};`）。 */
const sliceValidateFn = (source: string) => {
  const start = source.indexOf('const validateManifestCapabilities =');
  assert.ok(start >= 0, 'descriptor.ts 里必须存在 validateManifestCapabilities 声明');
  const end = source.indexOf('\n};', start);
  assert.ok(end > start, 'validateManifestCapabilities 函数体必须能定位到结尾');
  return source.slice(start, end);
};

test('V4-19：未知 capability 键能被识别（实测用例：water-lyrics 的 lyricsPage）', () => {
  assert.deepEqual(findUnknownCapabilityKeys({ lyricsPage: true }), ['lyricsPage']);
});

test('V4-19：已知键一律不算未知（全量遍历白名单）', () => {
  for (const key of KNOWN_PLUGIN_CAPABILITIES) {
    assert.deepEqual(
      findUnknownCapabilityKeys({ [key]: true }),
      [],
      `${key} 是已知 capability，不应被判为未知`,
    );
    assert.equal(
      isKnownPluginCapability(key),
      true,
      `${key} 应被 isKnownPluginCapability 认作已知`,
    );
  }
});

test('V4-19：未知键按字典序返回，便于日志与界面稳定输出', () => {
  assert.deepEqual(findUnknownCapabilityKeys({ zeta: true, alpha: true, lyricsPage: true }), [
    'alpha',
    'lyricsPage',
    'zeta',
  ]);
});

test('V4-19：已知与未知混合时只报未知那部分', () => {
  assert.deepEqual(
    findUnknownCapabilityKeys({ lyrics: true, localFiles: true, lyricsPage: true, foo: 1 }),
    ['foo', 'lyricsPage'],
  );
});

test('V4-19：非对象入参返回空数组（类型错误由校验函数负责，不在此重复判定）', () => {
  for (const value of [undefined, null, 'x', 42, true, [], ['lyrics']]) {
    assert.deepEqual(
      findUnknownCapabilityKeys(value),
      [],
      `非对象 ${JSON.stringify(value)} 应返回空数组`,
    );
  }
});

test('V4-19：空对象不产生告警', () => {
  assert.deepEqual(findUnknownCapabilityKeys({}), []);
});

test('V4-19：告警文案含键名，且不断言「插件坏了」', () => {
  const message = describeUnknownCapabilities(['lyricsPage']);
  assert.ok(message.includes('lyricsPage'), '文案必须点出具体的键名');
  assert.ok(
    message.includes('可能'),
    '未知键只说明「本项目不认识」，不得断言成确定性故障（可能是上游新能力或拼写错误）',
  );
  assert.equal(describeUnknownCapabilities([]), '', '无未知键时不得产出文案');
});

/**
 * 一致性守卫：白名单必须与 `descriptor.ts` 的校验序列**完全相同**。
 *
 * ⚠️ 为什么必须双向断言：只断言「白名单里的键都出现在校验序列里」会漏掉
 * **「新增了 capability 却忘了加进白名单」**这一侧 —— 那会让新键被判成未知、
 * 产生假告警。这正是 v1.3.5 总结的「`includes` 在同函数内多处会假绿」的同类陷阱，
 * 故这里比较的是**排序后的集合相等**。
 */
test('V4-19：KNOWN_PLUGIN_CAPABILITIES 与 descriptor.ts 的校验序列完全一致（双向）', () => {
  const body = sliceValidateFn(read('src/main/plugins/descriptor.ts'));
  const checked = [...body.matchAll(/capabilities\.([A-Za-z0-9_]+)\s*!==\s*undefined/g)].map(
    (m) => m[1],
  );

  const uniqueChecked = [...new Set(checked)].sort();
  const whitelist = [...KNOWN_PLUGIN_CAPABILITIES].sort();

  assert.deepEqual(
    uniqueChecked,
    whitelist,
    'descriptor.ts 里做类型校验的键集合，必须与 KNOWN_PLUGIN_CAPABILITIES 一致：' +
      '少了 → 新 capability 会被误判为未知；多了 → 白名单里存在从不校验的键',
  );
  // 校验序列本身不得有重复（同一键写两遍说明改漏了合并）
  assert.equal(checked.length, uniqueChecked.length, '校验序列不得出现重复的键');
});
