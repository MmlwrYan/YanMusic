import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SENSITIVE_KV_KEYS } from '../src/main/ipc/sensitiveKv.ts';

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
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① 把 `kv.ts` 的 `'pinia:device'` 从 `ENCRYPTED_KV_KEYS` 里删掉 → 用例 1、3 变红；
 *  ② 把 `get()` 里的迁移调用整行删掉 → 用例 4 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 从 `kv.ts` 源码里解析 `ENCRYPTED_KV_KEYS` 集合（该模块 import electron，无法在 node 下直接加载） */
const parseEncryptedKeys = (): string[] => {
  const source = read('src/main/storage/kv.ts');
  const block = source.match(/const ENCRYPTED_KV_KEYS[^=]*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'kv.ts 未找到 ENCRYPTED_KV_KEYS 定义');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

test('W-3：加密白名单必须同时含 pinia:user 与 pinia:device', () => {
  const keys = parseEncryptedKeys();
  assert.ok(keys.includes('pinia:user'), 'pinia:user（登录票据）必须加密落盘');
  assert.ok(keys.includes('pinia:device'), 'pinia:device（设备指纹）必须加密落盘');
});

test('W-3：加密白名单与 sensitiveKv 的运行时敏感键必须一致（两处不得漂移）', () => {
  const encrypted = new Set(parseEncryptedKeys());
  for (const key of SENSITIVE_KV_KEYS) {
    assert.ok(
      encrypted.has(key),
      `sensitiveKv 把 "${key}" 当敏感键，但 kv.ts 未加密它 —— 运行时挡住了、静态却在盘上`,
    );
  }
  for (const key of encrypted) {
    assert.ok(
      SENSITIVE_KV_KEYS.has(key),
      `kv.ts 加密了 "${key}"，但 sensitiveKv 未把它列为运行时敏感键 —— 两处口径不一致`,
    );
  }
});

test('W-3：迁移判定必须是「纯函数且默认不迁移」——非敏感键、空值一律 false', () => {
  const source = read('src/main/storage/kv.ts');
  assert.ok(
    /export const needsEncryptionMigration/.test(source),
    'needsEncryptionMigration 必须导出（可单测、可复用）',
  );
  assert.ok(
    /if \(!shouldEncryptKvKey\(key\)\) return false;/.test(source),
    '非敏感键不得进入迁移分支',
  );
  assert.ok(/if \(!raw\) return false;/.test(source), '空值不得进入迁移分支');
  assert.ok(
    /return !isEncryptedEnvelope\(parsed\);/.test(source),
    '判定应落在「不是信封」上（已是信封即幂等不再迁移）',
  );
});

test('W-3：get() 必须在读取路径上执行存量迁移，且失败不影响本次读取', () => {
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

test('W-3：迁移写入必须走 encodeForWrite（复用加密路径，不另写一份）', () => {
  const source = read('src/main/storage/kv.ts');
  assert.ok(
    /kvSet\(key, encodeForWrite\(key, raw\)\)/.test(source),
    '迁移必须复用 encodeForWrite，避免绕过加密信封格式',
  );
});
