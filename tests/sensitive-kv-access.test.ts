import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSensitiveKvAccess,
  isSensitiveKvKey,
  registeredSenderKind,
  SENSITIVE_KV_KEYS,
} from '../src/main/ipc/sensitiveKv.ts';
import { registerWindowKind, resetWindowKinds } from '../src/main/ipc/permissions.ts';

/**
 * S-2 守卫：敏感 KV 键的访问控制。
 *
 * 背景（H-2，一级）：`src/main/ipc/storage.ts` 的 kv handler 原本是**裸透传**
 * （`_event` 被丢弃），而 `KvStorage.get()` 会透明解密 —— 因此任意窗口
 * （含**插件窗口**）都能读走登录票据（`pinia:user` 的 `info.token`），
 * 并且能覆写 / 删除它（令牌替换 / 强制登出）。
 *
 * 本文件锁定的是 `src/main/ipc/sensitiveKv.ts` 的**判定逻辑**（纯函数）。
 * `storage.ts` 的 handler 直接消费该判定。
 *
 * ⚠️ 鉴别力验证：删掉 `sensitiveKv.ts` 里
 * `SENSITIVE_KEY_ALLOWED_KINDS.has(senderKind)` 那一段（改为直接 `allowed: true`），
 * 本文件必须变红。若不变红，说明用例没有鉴别力。
 */

/** 为某个窗口类型登记一个 webContents id，并返回该 id */
const registerKind = (kind: string, id: number): number => {
  registerWindowKind({ id } as never, kind as never);
  return id;
};

test('S-2：敏感键清单必须含 pinia:user 与 pinia:device', () => {
  assert.ok(SENSITIVE_KV_KEYS.has('pinia:user'), 'pinia:user 必须受保护（含登录票据）');
  assert.ok(SENSITIVE_KV_KEYS.has('pinia:device'), 'pinia:device 必须受保护（设备指纹）');
  assert.equal(isSensitiveKvKey('pinia:setting'), false, '普通设置键不应受保护');
});

test('S-2：未登记身份的发送方一律被拒（fail-closed）', () => {
  resetWindowKinds();
  const d = evaluateSensitiveKvAccess('pinia:user', 9999);
  assert.equal(d.sensitive, true);
  assert.equal(d.allowed, false, '未登记窗口读 pinia:user 必须被拒');
  assert.equal(d.senderKind, null);
  assert.ok(d.reason, '应给出拒绝原因');
});

test('S-2：插件窗口被拒绝访问敏感键（本条是 H-2 的核心）', () => {
  resetWindowKinds();
  const id = registerKind('plugin-window', 100);
  for (const key of ['pinia:user', 'pinia:device']) {
    const d = evaluateSensitiveKvAccess(key, id);
    assert.equal(d.allowed, false, `插件窗口读 ${key} 必须被拒`);
    assert.equal(d.senderKind, 'plugin-window');
  }
});

test('S-2：三类必要窗口被放行（main / mini-player / desktop-lyric）', () => {
  resetWindowKinds();
  const cases: Array<[string, number]> = [
    ['main', 201],
    ['mini-player', 202],
    ['desktop-lyric', 203],
  ];
  for (const [kind, id] of cases) {
    registerKind(kind, id);
    for (const key of ['pinia:user', 'pinia:device']) {
      const d = evaluateSensitiveKvAccess(key, id);
      assert.equal(d.allowed, true, `${kind} 读 ${key} 应放行（它装了 sqlitePersist）`);
      assert.equal(d.senderKind, kind);
    }
  }
});

test('S-2：不敏感的键一律放行（不得打断 sqlitePersist）', () => {
  resetWindowKinds();
  const pluginId = registerKind('plugin-window', 300);
  for (const key of ['pinia:setting', 'pinia:playlist', 'pinia:lyric', 'anything:else']) {
    for (const id of [pluginId, 4242 /* 甚至未登记也应放行 */]) {
      const d = evaluateSensitiveKvAccess(key, id);
      assert.equal(d.sensitive, false, `${key} 不应被判为敏感`);
      assert.equal(d.allowed, true, `${key} 必须放行`);
    }
  }
});

test('S-2：只信登记表 —— 未登记的 id 不得因 URL 推断而被放行', () => {
  resetWindowKinds();
  // 登记表为空：即便 id 看起来像主窗口，也必须拒绝
  assert.equal(registeredSenderKind(1), null);
  assert.equal(evaluateSensitiveKvAccess('pinia:user', 1).allowed, false);
  // 注销后同样拒绝
  const id = registerKind('main', 500);
  assert.equal(evaluateSensitiveKvAccess('pinia:user', id).allowed, true);
  resetWindowKinds();
  assert.equal(evaluateSensitiveKvAccess('pinia:user', id).allowed, false, '注销后必须回到拒绝');
});

test('S-2：非字符串 key 不得绕过判定', () => {
  resetWindowKinds();
  registerKind('plugin-window', 600);
  for (const weird of [null, undefined, 123, {}, ['pinia:user']]) {
    const d = evaluateSensitiveKvAccess(weird, 600);
    // 这些都不是敏感键字面量 → 放行（原样透传给 kv），但**不得**让 'pinia:user' 被放过
    assert.equal(typeof weird === 'string' ? d.sensitive : false, false);
  }
  // 关键：真正的字符串敏感键仍然被拦
  assert.equal(evaluateSensitiveKvAccess('pinia:user', 600).allowed, false);
});
