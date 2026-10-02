import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SENSITIVE_KV_KEYS } from '../src/main/ipc/sensitiveKv.ts';
// F-6（v1.3.0）：加密信封的纯逻辑已在零依赖模块中，可**直接 import 做真行为断言**，
// 不再依赖「正则解析 kv.ts 源码」。
import {
  ENCRYPTED_KV_KEYS,
  ENVELOPE_KEY,
  isEncryptedEnvelope,
  needsEncryptionMigration,
  shouldEncryptKvKey,
} from '../src/shared/kvEnvelope.ts';

/**
 * W-3 守卫：凭据/指纹的**加密白名单**与**存量迁移**。
 *
 * 背景（M-4 / W-3）：v1.2.4 引入了 `ENCRYPTED_KV_KEYS`（safeStorage 静态加密），
 * 但白名单里只有 `pinia:user`，同一次改动漏掉了 `pinia:device`
 * （dfid / mid / uuid / guid / mac 设备指纹）→ 指纹以明文留在 `YanMusic.sqlite`。
 *
 * 更关键的是：**只往白名单里加一个字符串，对存量用户完全无效** ——
 * 读路径遇到非信封会「原样直通」，而 `pinia:device` 几乎不再被写，
 * 旧明文会永久留在盘上。因此本版同时加了「读时惰性迁移」（`needsEncryptionMigration`）。
 *
 * ## 本文件的两种断言（F-6，v1.3.0 起）
 *
 * - **行为断言**（用例 1–3）：直接 import `shared/kvEnvelope.ts` 并驱动真实函数。
 *   该模块**零依赖**（无 Electron、无 IO），因此能在 `node --test` 下加载。
 * - **源码断言**（用例 4–5）：守的是 `kv.ts` 里的 **IO 编排**
 *   （`get()` 何时调用迁移、迁移失败如何降级、写入是否复用 `encodeForWrite`）。
 *   这些逻辑依赖 `safeStorage` / 原生存储，**无法在 node 下加载执行**，
 *   所以只能做源码级断言 —— 这是**结构审计**，不是行为验证。此处**如实标注**，
 *   不假装它是行为测试。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① 把 `shared/kvEnvelope.ts` 的 `'pinia:device'` 从 `ENCRYPTED_KV_KEYS` 删掉 → 用例 1、2 变红；
 *  ② 把 `needsEncryptionMigration` 改成恒 `return false` → 用例 3 变红；
 *  ③ 把 `kv.ts` 的 `get()` 里迁移调用整行删掉 → 用例 4 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ── 行为断言（真函数） ──────────────────────────────────────────────────

test('W-3：加密白名单必须同时含 pinia:user 与 pinia:device', () => {
  assert.ok(shouldEncryptKvKey('pinia:user'), 'pinia:user（登录票据）必须加密落盘');
  assert.ok(shouldEncryptKvKey('pinia:device'), 'pinia:device（设备指纹）必须加密落盘');
  assert.ok(
    ENCRYPTED_KV_KEYS.has('pinia:user') && ENCRYPTED_KV_KEYS.has('pinia:device'),
    '白名单集合本身必须含这两个键',
  );
});

test('W-3：加密白名单与 sensitiveKv 的运行时敏感键必须一致（两处不得漂移）', () => {
  for (const key of SENSITIVE_KV_KEYS) {
    assert.ok(
      ENCRYPTED_KV_KEYS.has(key),
      `sensitiveKv 把 "${key}" 当敏感键，但 kvEnvelope 未加密它 —— 运行时挡住了、静态却在盘上`,
    );
  }
  for (const key of ENCRYPTED_KV_KEYS) {
    assert.ok(
      SENSITIVE_KV_KEYS.has(key),
      `kvEnvelope 加密了 "${key}"，但 sensitiveKv 未把它列为运行时敏感键 —— 两处口径不一致`,
    );
  }
});

test('W-3：needsEncryptionMigration 的真行为（非敏感键 / 空值 / 明文 / 信封 / 非法 JSON）', () => {
  const envelope = JSON.stringify({ [ENVELOPE_KEY]: 'Y2lwaGVy' });

  // 1) 非敏感键一律不迁移 —— 这是「只加密白名单、其余保持明文」的硬边界
  assert.equal(needsEncryptionMigration('pinia:setting', '{"a":1}'), false, '非敏感键不得迁移');
  assert.equal(
    needsEncryptionMigration('pinia:setting', envelope),
    false,
    '非敏感键（即便长相像信封）也不迁移',
  );

  // 2) 空值不迁移
  assert.equal(needsEncryptionMigration('pinia:device', null), false, 'null 不迁移');
  assert.equal(needsEncryptionMigration('pinia:device', undefined), false, 'undefined 不迁移');
  assert.equal(needsEncryptionMigration('pinia:device', ''), false, '空串不迁移');

  // 3) 敏感键 + 明文 JSON → 必须迁移（这正是 W-3 第二步要解决的存量问题）
  assert.equal(
    needsEncryptionMigration('pinia:device', '{"info":{"dfid":"abc"}}'),
    true,
    '敏感键的明文 JSON 必须被判定为需要迁移',
  );
  assert.equal(
    needsEncryptionMigration('pinia:user', '{"info":{"token":"t"}}'),
    true,
    'pinia:user 同理',
  );
  // 非对象明文（JSON 标量）也仍是「未加密」，应迁移
  assert.equal(needsEncryptionMigration('pinia:user', '"plain"'), true, 'JSON 字符串标量应迁移');
  assert.equal(needsEncryptionMigration('pinia:user', '123'), true, 'JSON 数字标量应迁移');

  // 4) 已是信封 → 幂等，不再迁移
  assert.equal(needsEncryptionMigration('pinia:device', envelope), false, '已加密应幂等不迁移');
  assert.equal(needsEncryptionMigration('pinia:user', envelope), false, '同上');
  // 数组不是合法信封（isEncryptedEnvelope 明确排除 Array）→ 仍应迁移
  assert.equal(
    needsEncryptionMigration('pinia:user', JSON.stringify([{ [ENVELOPE_KEY]: 'x' }])),
    true,
    '数组不是信封，应判定为未加密',
  );

  // 5) 非法 JSON → 不迁移（避免在损坏数据上写入无法预期的内容）
  assert.equal(needsEncryptionMigration('pinia:device', '{not json'), false, '非法 JSON 不迁移');
  assert.equal(needsEncryptionMigration('pinia:user', 'undefined'), false, '非法 JSON 不迁移');
});

test('F-6：isEncryptedEnvelope 的真行为边界（对象 / 数组 / null / 缺失键 / 非字符串值）', () => {
  assert.equal(isEncryptedEnvelope({ [ENVELOPE_KEY]: 'cipher' }), true, '正常信封');
  assert.equal(isEncryptedEnvelope({ [ENVELOPE_KEY]: '' }), true, '空字符串仍是 string，算信封');
  assert.equal(isEncryptedEnvelope({ [ENVELOPE_KEY]: 123 }), false, '非 string 不算信封');
  assert.equal(isEncryptedEnvelope({}), false, '缺标记不算信封');
  assert.equal(isEncryptedEnvelope(null), false, 'null 不算信封');
  assert.equal(isEncryptedEnvelope(undefined), false, 'undefined 不算信封');
  assert.equal(isEncryptedEnvelope([{ [ENVELOPE_KEY]: 'x' }]), false, '数组不算信封（显式排除）');
  assert.equal(isEncryptedEnvelope('string'), false, '字符串标量不算信封');
  assert.equal(isEncryptedEnvelope(42), false, '数字不算信封');
});

// ── 源码断言（守 kv.ts 的 IO 编排；该模块 import electron，无法在 node 下加载） ──

test('[结构审计] W-3：get() 必须在读取路径上执行存量迁移，且失败不影响本次读取', () => {
  const source = read('src/main/storage/kv.ts');
  assert.ok(
    /if \(needsEncryptionMigration\(key, raw\)\) migratePlaintextToEnvelope\(key, raw as string\);/.test(
      source,
    ),
    'get() 未调用迁移 —— 存量明文将永久留在磁盘上',
  );
  assert.ok(
    /catch \(error\)[\s\S]{0,200}log\.warn[\s\S]{0,200}存量明文迁移失败/.test(source),
    '迁移失败必须只记日志，不得让本次读取失败（否则 Linux 无 keyring 会直接读不到数据）',
  );
});

test('[结构审计] W-3：迁移写入必须走 encodeForWrite（复用加密路径，不另写一份）', () => {
  const source = read('src/main/storage/kv.ts');
  assert.ok(
    /kvSet\(key, encodeForWrite\(key, raw\)\)/.test(source),
    '迁移必须复用 encodeForWrite，避免绕过加密信封格式',
  );
});

test('F-6：kv.ts 不得再自带一份加密信封实现（必须从 shared/kvEnvelope 导入）', () => {
  const source = read('src/main/storage/kv.ts');
  assert.ok(
    /from '\.\.\/\.\.\/shared\/kvEnvelope'/.test(source),
    'kv.ts 必须从 shared/kvEnvelope 导入纯逻辑（否则又出现两份口径）',
  );
  assert.ok(
    !/const ENCRYPTED_KV_KEYS/.test(source),
    'kv.ts 不得再自定义 ENCRYPTED_KV_KEYS —— 单一真源在 shared/kvEnvelope.ts',
  );
  assert.ok(
    !/const needsEncryptionMigration/.test(source),
    'kv.ts 不得再自定义 needsEncryptionMigration',
  );
});
