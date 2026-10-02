import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStartupDegradations,
  hasFatalStartupDegradation,
  recordStartupDegradation,
  resetStartupDiagnosticsForTest,
} from '../src/main/startupDiagnostics.ts';

/**
 * S-3（v1.3.0）守卫：启动降级记录。
 *
 * ## 为什么需要
 *
 * 修复前启动期关键服务的失败处理**不一致且用户无感知**：
 * - `initApiServer` / `initMpvPlayer` 失败**只写 `log.error`** → 应用照常打开，
 *   但音频引擎或内置 API 是坏的，界面不告诉用户任何事（表现为「能开但放不了歌」）；
 * - `storage/native.ts` 的 addon 加载失败**直接 `throw`** → 可能崩在窗口创建前，
 *   用户只看到「应用打不开」，没有解释、也无从自救。
 *
 * 本模块是修复的**数据基础**：把降级项记录下来，供渲染层提示（`setting.ts` 的
 * `reportStartupDegradations`）与诊断包（S-6）使用。
 * 由于它零依赖，这里可以直接驱动**真行为**而不是源码正则。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `recordStartupDegradation` 改成直接 return（不记录）→ 用例 1–3 变红。
 */

test('S-3：记录降级项并可按快照读回', () => {
  resetStartupDiagnosticsForTest();

  assert.deepEqual(getStartupDegradations(), [], '初始应为空');
  assert.equal(hasFatalStartupDegradation(), false, '初始不应有致命项');

  recordStartupDegradation({ kind: 'mpv', message: '音频引擎初始化失败', fatal: false });

  const snapshot = getStartupDegradations();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    kind: 'mpv',
    message: '音频引擎初始化失败',
    fatal: false,
  });

  resetStartupDiagnosticsForTest();
});

test('S-3：同一 kind 只保留首次（启动路径存在重试，避免重复提示与诊断包失真）', () => {
  resetStartupDiagnosticsForTest();

  recordStartupDegradation({ kind: 'mpv', message: '第一次失败', fatal: false });
  recordStartupDegradation({ kind: 'mpv', message: '第二次失败', fatal: false });
  recordStartupDegradation({ kind: 'mpv', message: '第三次失败', fatal: false });

  const snapshot = getStartupDegradations();
  assert.equal(snapshot.length, 1, '同一 kind 必须只记一次');
  assert.equal(snapshot[0].message, '第一次失败', '应保留首次的原因');

  // 不同 kind 仍各自记录
  recordStartupDegradation({ kind: 'api-server', message: 'API 未启动', fatal: false });
  assert.equal(getStartupDegradations().length, 2);

  resetStartupDiagnosticsForTest();
});

test('S-3：fatal 项决定「是否应优雅退出」（native-storage 不可降级）', () => {
  resetStartupDiagnosticsForTest();

  recordStartupDegradation({ kind: 'mpv', message: '音频引擎失败', fatal: false });
  assert.equal(
    hasFatalStartupDegradation(),
    false,
    '音频引擎失败是**可降级**的：界面仍可用，不应让应用退出',
  );

  recordStartupDegradation({ kind: 'native-storage', message: '存储组件加载失败', fatal: true });
  assert.equal(
    hasFatalStartupDegradation(),
    true,
    '存储不可用是**不可降级**的：调用方据此弹明确提示并优雅退出',
  );

  resetStartupDiagnosticsForTest();
});

test('S-3：快照是副本（外部改动不得影响内部状态）', () => {
  resetStartupDiagnosticsForTest();
  recordStartupDegradation({ kind: 'api-server', message: '原始说明', fatal: false });

  const snapshot = getStartupDegradations();
  snapshot[0].message = '被外部篡改';
  snapshot.push({ kind: 'mpv', message: '外部塞入', fatal: true });

  const fresh = getStartupDegradations();
  assert.equal(fresh.length, 1, '外部 push 不得影响内部记录');
  assert.equal(fresh[0].message, '原始说明', '外部改动不得影响内部记录');
  assert.equal(hasFatalStartupDegradation(), false, '外部塞入的 fatal 项不得影响判定');

  resetStartupDiagnosticsForTest();
});

test('S-3：空/非法 message 有兜底，不得把 undefined 甩到界面上', () => {
  resetStartupDiagnosticsForTest();

  recordStartupDegradation({ kind: 'mpv', message: '   ', fatal: false });
  recordStartupDegradation({
    kind: 'api-server',
    message: undefined as unknown as string,
    fatal: false,
  });

  const snapshot = getStartupDegradations();
  assert.equal(snapshot.length, 2);
  for (const item of snapshot) {
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0, 'message 必须有兜底文案，否则渲染层会显示空白提示');
  }

  resetStartupDiagnosticsForTest();
});
