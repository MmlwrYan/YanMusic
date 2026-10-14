import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createPluginSenderGuard,
  getUnknownSenderCounters,
  getUnknownSenderTotal,
  registerPluginSender,
  resetPluginSenderRegistryForTest,
  resetUnknownSenderCountersForTest,
} from '../src/main/plugins/senderIdentity.ts';

/**
 * V4-09（v1.4.0）：P-3「未知来源」计数的**聚合出口**。
 *
 * 背景：该计数从 v1.3.0 起就在产生，但**只写日志、没有出口**，于是
 * 「能否把 unknown-sender 从放行收紧为拒绝」这个决定一直没有依据。
 * 运行时实测（2026-10-14）已证明它一直在产数据（`plugins:set-enabled` /
 * `plugins:read-asset` / `plugins:data:get` 各命中过）。
 *
 * 本文件守两件事：
 *   ① 计数的**真行为**：未知来源被计入、已知来源不计入、按次数降序；
 *   ② 与诊断包的**接线**：`bundle.ts` 必须真的把它写进 `diagnostics.json`。
 *
 * **怎样改会变红**：把 `getUnknownSenderCounters` 改成恒返回 `[]`，
 * 或把 `bundle.ts` 里那两个字段删掉。
 */

/** 取一个「未登记」的 webContentsId，制造 unknown-sender 情形。 */
const UNREGISTERED = 999_001;

const setup = () => {
  resetPluginSenderRegistryForTest();
  resetUnknownSenderCountersForTest();
};

test('V4-09：初始状态为空（不得凭空报数）', () => {
  setup();
  assert.deepEqual(getUnknownSenderCounters(), []);
  assert.equal(getUnknownSenderTotal(), 0);
});

test('V4-09：未知来源（插件在主窗口内运行）会被计入，且按次数降序', () => {
  setup();
  const guard = createPluginSenderGuard();

  // 同一通道调 3 次
  for (let i = 0; i < 3; i++) {
    const verdict = guard({
      channel: 'plugins:data:get',
      webContentsId: UNREGISTERED,
      args: ['demo-plugin'],
    });
    assert.deepEqual(verdict, { ok: true }, '未知来源按保守策略放行（不是拒绝）');
  }
  // 另一通道调 1 次
  guard({ channel: 'plugins:read-asset', webContentsId: UNREGISTERED, args: ['demo-plugin'] });

  assert.deepEqual(getUnknownSenderCounters(), [
    { channel: 'plugins:data:get', count: 3 },
    { channel: 'plugins:read-asset', count: 1 },
  ]);
  assert.equal(getUnknownSenderTotal(), 4);
});

test('V4-09：同次数的通道按通道名排序（输出稳定，便于肉眼比对两个诊断包）', () => {
  setup();
  const guard = createPluginSenderGuard();
  // ⚠️ 必须用**白名单里真实存在**的通道：守卫对白名单外的通道直接放行且不计数，
  // 用编造的通道名会得到空结果（这不是 bug，是刻意的降噪设计）。
  for (const channel of ['plugins:read-asset', 'plugins:data:get']) {
    guard({ channel, webContentsId: UNREGISTERED, args: ['p'] });
  }
  assert.deepEqual(
    getUnknownSenderCounters().map((x) => x.channel),
    ['plugins:data:get', 'plugins:read-asset'],
  );
});

test('V4-09：反查成功且一致（正品插件）不计入未知来源', () => {
  setup();
  const webContentsId = 42_001;
  registerPluginSender(webContentsId, 'water-lyrics');
  const guard = createPluginSenderGuard();

  const verdict = guard({
    channel: 'plugins:data:get',
    webContentsId,
    args: ['water-lyrics'],
  });
  assert.deepEqual(verdict, { ok: true });
  assert.deepEqual(getUnknownSenderCounters(), [], '正品插件的正常路径不得被计入');
});

test('V4-09：冒充他人（mismatch）被拒，且**不**计入未知来源（两种情形语义不同）', () => {
  setup();
  const webContentsId = 42_002;
  registerPluginSender(webContentsId, 'plugin-b');
  const guard = createPluginSenderGuard();

  const verdict = guard({
    channel: 'plugins:data:get',
    webContentsId,
    args: ['plugin-a'],
  });
  assert.equal(verdict.ok, false, '冒充必须被拒');
  assert.deepEqual(
    getUnknownSenderCounters(),
    [],
    'mismatch 是「可判定并已拒绝」，unknown-sender 是「不可判定只能放行」——不得混为一谈',
  );
});

test('V4-09：不在白名单内的通道不产生计数（避免用无关高频道污染观测）', () => {
  setup();
  const guard = createPluginSenderGuard();
  guard({ channel: 'storage:kv:get', webContentsId: UNREGISTERED, args: ['pinia:user'] });
  assert.deepEqual(getUnknownSenderCounters(), []);
});

test('V4-09：快照是**副本**（外部改动不得影响内部计数）', () => {
  setup();
  const guard = createPluginSenderGuard();
  guard({ channel: 'plugins:data:get', webContentsId: UNREGISTERED, args: ['p'] });

  const snapshot = getUnknownSenderCounters();
  snapshot.push({ channel: 'injected', count: 999 });
  snapshot[0].count = 12345;

  assert.deepEqual(getUnknownSenderCounters(), [{ channel: 'plugins:data:get', count: 1 }]);
});

/**
 * 接线守卫：诊断包必须**真的**收录这项数据。
 *
 * ⚠️ 只断言 `getUnknownSenderCounters` 出现在 `bundle.ts` 里是**假守卫**
 *（v1.3.5 的教训：标识符在同文件多处出现会让 `includes` 恒真）。
 * 这里断言的是对象字面量里**确实有这两个键**（行首锚定）。
 */
test('V4-09：诊断包真的收录 unknown-sender 汇总（行首锚定，防假绿）', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = readFileSync(path.join(root, 'src/main/diagnostics/bundle.ts'), 'utf8');

  assert.ok(
    /^\s*pluginIdentity:\s*\{/m.test(bundle),
    'diagnostics.json 里必须有 pluginIdentity 段',
  );
  assert.ok(
    /^\s*unknownSenderChannels:\s*redactValue\(getUnknownSenderCounters\(\)/m.test(bundle),
    'pluginIdentity.unknownSenderChannels 必须由 getUnknownSenderCounters() 填充',
  );
  assert.ok(
    /^\s*unknownSenderTotal:\s*getUnknownSenderTotal\(\)/m.test(bundle),
    'pluginIdentity.unknownSenderTotal 必须由 getUnknownSenderTotal() 填充',
  );
  assert.ok(
    bundle.includes("from '../plugins/senderIdentity'"),
    '必须真的 import 该模块，而不是留一段等价的本地实现',
  );
});
