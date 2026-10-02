import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_IDENTITY_CHANNELS,
  createPluginSenderGuard,
  evaluatePluginIdentity,
  registerPluginSender,
  resetPluginSenderRegistryForTest,
  resolvePluginIdByWebContentsId,
  unregisterPluginSender,
  type PluginIdentityMismatchInfo,
} from '../src/main/plugins/senderIdentity.ts';

/**
 * P-3（v1.3.0）守卫：插件能力调用的**发送方身份绑定**（M-1）。
 *
 * ## 锁的是什么
 *
 * 修复前所有 `plugins:` 能力通道按**调用方自报的 `pluginId` 入参**做能力判定，
 * 于是任何能触达 IPC 的代码都能冒充其他插件（删他人的库、以他人身份写文件/发请求）。
 * 本文件锁定「以发送方反查结果为准」这一语义。
 *
 * **P-1 不能替代本项**：插件与宿主同 realm，可直接访问 `window.electron.plugins.*`。
 * P-1 收窄入口，P-3 才是不信自报身份。
 *
 * ## 两类断言
 *
 * - **真行为断言**（用例 1–3）：`senderIdentity.ts` **零依赖**，直接 import 驱动真实函数。
 * - **源码守卫**（用例 4–5）：扫描本仓库所有 `plugins:` 注册，保证「首参是 pluginId 的通道」
 *   与白名单**双向一致** —— 防将来新增通道漏纳入（漏了 = 该通道身份校验静默失效）。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① `evaluatePluginIdentity` 改成恒 `allow` → 用例 2 变红；
 *  ② 从 `PLUGIN_IDENTITY_CHANNELS` 删掉 `plugins:sqlite:delete` → 用例 2、4 变红；
 *  ③ `registerPluginSender` 改成不写入 → 用例 1 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const collectMainSources = (): Array<{ rel: string; source: string }> => {
  const results: Array<{ rel: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (!statSync(full).isFile()) continue;
      results.push({
        rel: path.relative(repoRoot, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(path.join(repoRoot, 'src', 'main'));
  return results;
};

/** 提取「首参形如 pluginId」的 plugins: 通道（含 `async (event, pluginId` 写法）。 */
const collectPluginIdFirstArgChannels = (): string[] => {
  const found: string[] = [];
  for (const { source } of collectMainSources()) {
    const re = /register(?:Handler|Listener)\(\s*'([^']+)'\s*,\s*([\s\S]{0,260}?)(?:=>|\{)/g;
    for (const m of source.matchAll(re)) {
      const channel = m[1];
      if (!channel.startsWith('plugins:')) continue;
      // `pluginId\b` 不会误匹配 `pluginIds`（\b 在 s 后不成立）—— 这正是我们要的：
      // `pluginIds: string[]` 是宿主批量上报，不是插件自证身份。
      if (/(?:_event|event)\s*,\s*pluginId\b/.test(m[2])) found.push(channel);
    }
  }
  return found;
};

// ── 真行为断言 ──────────────────────────────────────────────────────────

test('P-3：注册表按 webContentsId 反查插件身份，注销后失效', () => {
  resetPluginSenderRegistryForTest();

  assert.equal(resolvePluginIdByWebContentsId(1), null, '未登记时应返回 null（未知来源）');
  assert.equal(resolvePluginIdByWebContentsId(undefined), null, 'undefined 应返回 null');

  registerPluginSender(42, 'plugin.alpha');
  assert.equal(resolvePluginIdByWebContentsId(42), 'plugin.alpha');

  // 非法入参静默忽略（不抛错，也不产生错误映射）
  registerPluginSender(0, 'plugin.zero');
  registerPluginSender(-1, 'plugin.negative');
  registerPluginSender(43, '   ');
  assert.equal(resolvePluginIdByWebContentsId(0), null, '非正整数 id 不得登记');
  assert.equal(resolvePluginIdByWebContentsId(-1), null, '负数 id 不得登记');
  assert.equal(resolvePluginIdByWebContentsId(43), null, '空 pluginId 不得登记');

  unregisterPluginSender(42);
  assert.equal(resolvePluginIdByWebContentsId(42), null, '注销后必须失效');

  resetPluginSenderRegistryForTest();
});

test('P-3：evaluatePluginIdentity 的判定语义（一致放行 / 不一致拒绝 / 未知来源放行）', () => {
  // 1) 反查成功且一致 → 放行（正品插件的正常路径）
  assert.equal(evaluatePluginIdentity('plugin.a', 'plugin.a'), 'allow');

  // 2) 反查成功但不一致 → 拒绝（本项要拦的冒充行为）
  assert.equal(
    evaluatePluginIdentity('plugin.a', 'plugin.b'),
    'mismatch',
    '声明 B、实际来自 A 必须被拒 —— 这正是 M-1 要堵的冒充路径',
  );

  // 3) 未知来源（主窗口内的插件无法反查）→ **放行**。
  //    这是规划 §7 明确的保守策略：宁可漏拦，不可误拒正品插件。
  assert.equal(
    evaluatePluginIdentity(null, 'plugin.a'),
    'allow',
    '未知来源必须放行（否则主窗口内的正品插件会被大面积误拒，影响评级为高）',
  );

  // 4) 声明值不是非空字符串 → 本校验不适用，放行（如可选参数缺省、首参为数组）
  assert.equal(evaluatePluginIdentity('plugin.a', undefined), 'allow');
  assert.equal(evaluatePluginIdentity('plugin.a', null), 'allow');
  assert.equal(evaluatePluginIdentity('plugin.a', ''), 'allow');
  assert.equal(evaluatePluginIdentity('plugin.a', 123), 'allow');
  assert.equal(evaluatePluginIdentity('plugin.a', ['plugin.a']), 'allow');
});

test('P-3：createPluginSenderGuard 只对白名单通道生效，并回传拒绝原因', () => {
  resetPluginSenderRegistryForTest();
  registerPluginSender(7, 'plugin.owner');

  const mismatches: PluginIdentityMismatchInfo[] = [];
  const guard = createPluginSenderGuard((info) => mismatches.push(info));

  // 非白名单通道：任何情况都放行（身份校验不适用于它）
  assert.deepEqual(
    guard({ channel: 'plugins:list', webContentsId: 7, args: ['plugin.other'] }),
    { ok: true },
    '非白名单通道不得被拦截',
  );
  assert.deepEqual(guard({ channel: 'storage:kv:get', webContentsId: 7, args: ['pinia:user'] }), {
    ok: true,
  });

  // 白名单通道 + 一致 → 放行
  assert.deepEqual(
    guard({ channel: 'plugins:sqlite:delete', webContentsId: 7, args: ['plugin.owner', 'db'] }),
    { ok: true },
  );

  // 白名单通道 + 不一致 → 拒绝，且必须回调（供审计日志）
  const denied = guard({
    channel: 'plugins:sqlite:delete',
    webContentsId: 7,
    args: ['plugin.victim', 'db'],
  });
  assert.equal(denied.ok, false, '冒充他人身份删库必须被拒');
  if (!denied.ok) assert.match(denied.error, /身份不匹配/);
  assert.equal(mismatches.length, 1, '拒绝时必须回调一次（否则没有审计痕迹）');
  assert.equal(mismatches[0].resolvedPluginId, 'plugin.owner');
  assert.equal(mismatches[0].claimedPluginId, 'plugin.victim');

  // 白名单通道 + 未知来源 → 放行，且**不得**产生审计噪声
  assert.deepEqual(
    guard({ channel: 'plugins:sqlite:delete', webContentsId: 999, args: ['plugin.anyone', 'db'] }),
    { ok: true },
    '未知来源放行（保守策略）',
  );
  assert.equal(mismatches.length, 1, '放行不得触发 mismatch 回调');

  resetPluginSenderRegistryForTest();
});

// ── 源码守卫：白名单与真实注册双向一致 ──────────────────────────────────

test('P-3：凡「首参是 pluginId」的 plugins: 通道都必须纳入身份校验白名单', () => {
  const actual = collectPluginIdFirstArgChannels();
  assert.ok(actual.length >= 40, `扫描到的通道过少（${actual.length}）—— 守卫可能失效`);

  const missing = actual.filter((channel) => !PLUGIN_IDENTITY_CHANNELS.has(channel));
  assert.deepEqual(
    missing,
    [],
    '以下通道的首参是 pluginId 却不在 PLUGIN_IDENTITY_CHANNELS 中 —— ' +
      '这些通道可被冒充调用，身份校验静默失效。请评估后加入白名单（或改写入参语义）',
  );
});

test('P-3：白名单不得含「首参不是 pluginId」的通道（防误拒正品插件）', () => {
  const actual = new Set(collectPluginIdFirstArgChannels());
  const redundant = [...PLUGIN_IDENTITY_CHANNELS].filter((channel) => !actual.has(channel));
  assert.deepEqual(
    redundant,
    [],
    '以下通道在白名单中，但其注册签名的首参并非 pluginId —— ' +
      '若其首参是别的字符串（如 key/sourceId），校验会拿它去比对 sender 归属，**可能误拒正品插件**。' +
      '请从白名单移除，或修正该通道的入参语义',
  );
});
