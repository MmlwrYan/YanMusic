import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLUGIN_TLS_RELAXATION_BLOCKED_CODE,
  PLUGIN_TLS_RELAXATION_BLOCKED_MESSAGE,
  checkPluginTlsPolicy,
  isPluginTlsRelaxationAllowed,
} from '../src/shared/plugins.ts';

/**
 * IMP-13：插件不得在生产环境关闭 TLS 证书校验。
 *
 * 复现（修复前）：
 *   `src/shared/plugins.ts:376-381` 的 `PluginNetworkTlsOptions.rejectUnauthorized`
 *   由插件清单/调用方直接声明，`src/main/plugins/network.ts:203-208` 据此创建
 *   `new HttpsAgent({ rejectUnauthorized: options.tls.rejectUnauthorized })`，
 *   生产环境下插件可让应用对目标站点不做证书校验 → 中间人可篡改响应。
 *
 * 修复口径：`rejectUnauthorized: false` 仅在**开发模式**（未打包）下允许；
 * 生产环境返回可上报的错误。用户显式确认那条路径需要新增 IPC 通道与 UI，
 * 本轮不动（见 CHANGELOG 说明）。
 */

test('checkPluginTlsPolicy：生产环境拒绝 rejectUnauthorized:false', () => {
  const message = checkPluginTlsPolicy(
    { tls: { rejectUnauthorized: false } },
    { isDevelopment: false },
  );
  assert.equal(message, PLUGIN_TLS_RELAXATION_BLOCKED_MESSAGE);
  assert.ok(message && message.length > 0);
  assert.ok(PLUGIN_TLS_RELAXATION_BLOCKED_CODE.length > 0);
});

test('checkPluginTlsPolicy：开发模式允许 rejectUnauthorized:false', () => {
  assert.equal(
    checkPluginTlsPolicy({ tls: { rejectUnauthorized: false } }, { isDevelopment: true }),
    null,
  );
});

test('checkPluginTlsPolicy：默认与显式 true 一律放行（不改变既有行为）', () => {
  // 未声明 tls
  assert.equal(checkPluginTlsPolicy({}, { isDevelopment: false }), null);
  assert.equal(checkPluginTlsPolicy(undefined, { isDevelopment: false }), null);
  assert.equal(checkPluginTlsPolicy(null, { isDevelopment: false }), null);
  // 声明了 tls 但未放宽
  assert.equal(checkPluginTlsPolicy({ tls: {} }, { isDevelopment: false }), null);
  assert.equal(
    checkPluginTlsPolicy({ tls: { rejectUnauthorized: true } }, { isDevelopment: false }),
    null,
  );
  // 只改 SNI（不影响证书校验）
  assert.equal(
    checkPluginTlsPolicy({ tls: { servername: 'example.com' } }, { isDevelopment: false }),
    null,
  );
});

test('checkPluginTlsPolicy：仅严格等于 false 视为放宽（不做真值转换）', () => {
  // 0 / '' / undefined 都不是「放宽」，不能被误判为放宽
  for (const value of [undefined, 0, '', 'false', 1, true]) {
    assert.equal(
      checkPluginTlsPolicy(
        { tls: { rejectUnauthorized: value as never } },
        { isDevelopment: false },
      ),
      null,
      `rejectUnauthorized=${JSON.stringify(value)} 不应被视为放宽`,
    );
  }
  assert.notEqual(
    checkPluginTlsPolicy({ tls: { rejectUnauthorized: false } }, { isDevelopment: false }),
    null,
  );
});

test('isPluginTlsRelaxationAllowed：只有明确的 isDevelopment=true 才算开发模式', () => {
  assert.equal(isPluginTlsRelaxationAllowed({ isDevelopment: true }), true);
  assert.equal(isPluginTlsRelaxationAllowed({ isDevelopment: false }), false);
  // 上下文缺失时按生产环境处理（fail-closed）
  assert.equal(isPluginTlsRelaxationAllowed(undefined as never), false);
  assert.equal(isPluginTlsRelaxationAllowed({} as never), false);
  assert.equal(isPluginTlsRelaxationAllowed({ isDevelopment: 'yes' } as never), false);
});
