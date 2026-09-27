import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLUGIN_STATS_KEY_ENV,
  PLUGIN_STATS_KEY_HEADER,
  PLUGIN_STATS_WRITE_MAX_PER_WINDOW,
  PLUGIN_STATS_WRITE_WINDOW_MS,
  checkRateLimit,
  isWriteAuthorized,
  readStatsKeyFromHeaders,
  safeEqual,
} from '../src/shared/pluginStatsAuth.ts';

/**
 * M-7：插件市场统计写入端点最小鉴权。
 *
 * 复现（修复前）：`cloudflare/plugin-marketplace-worker/worker.js` 的
 * `/v1/plugins/events` 无鉴权、`access-control-allow-origin: *`，
 * 任何人可 POST 任意 sourceId/pluginId 刷高或刷低 install/update/failure 计数，
 * 而 `computeScore = installs*3 + todayInstalls*5 - failures*2` 直接决定排行榜。
 *
 * 修复口径：写入需 `X-YanMusic-Key` 命中服务端 secret；**服务端未配置密钥时 fail closed**；
 * 并对每 IP 做固定窗口限流。读取端点不鉴权（排行榜要公开展示）。
 */

test('safeEqual：常时比较的相等/不等判定', () => {
  assert.equal(safeEqual('secret-key-123', 'secret-key-123'), true);
  assert.equal(safeEqual('secret-key-123', 'secret-key-124'), false);
  assert.equal(safeEqual('short', 'longer-value'), false);
  assert.equal(safeEqual('', ''), true);
});

test('safeEqual：非字符串输入返回 false（不抛异常）', () => {
  assert.equal(safeEqual(undefined as unknown as string, 'x'), false);
  assert.equal(safeEqual('x', null as unknown as string), false);
  assert.equal(safeEqual(123 as unknown as string, 123 as unknown as string), false);
});

test('isWriteAuthorized：正确密钥放行', () => {
  assert.equal(isWriteAuthorized('k-abc', 'k-abc'), true);
  assert.equal(isWriteAuthorized('  k-abc  ', 'k-abc'), true, '应容忍前后空白');
});

test('isWriteAuthorized：密钥错误/缺失时拒绝', () => {
  assert.equal(isWriteAuthorized('wrong', 'k-abc'), false);
  assert.equal(isWriteAuthorized('', 'k-abc'), false);
  assert.equal(isWriteAuthorized(undefined, 'k-abc'), false);
  assert.equal(isWriteAuthorized(null, 'k-abc'), false);
});

test('isWriteAuthorized：服务端未配置密钥时 fail closed（关键回归）', () => {
  // 若此处返回 true，就等价于「忘记配 secret = 写入口重新敞开」，与修复前无异。
  assert.equal(isWriteAuthorized('anything', ''), false);
  assert.equal(isWriteAuthorized('anything', undefined), false);
  assert.equal(isWriteAuthorized('anything', null), false);
  // 攻击者也不能靠提交空密钥绕过
  assert.equal(isWriteAuthorized('', ''), false);
});

test('readStatsKeyFromHeaders：支持 Headers.get 与普通对象（大小写不敏感）', () => {
  const headersLike = {
    get: (name: string) => (name.toLowerCase() === PLUGIN_STATS_KEY_HEADER ? 'k-from-get' : null),
  };
  assert.equal(readStatsKeyFromHeaders(headersLike), 'k-from-get');

  assert.equal(readStatsKeyFromHeaders({ 'X-YanMusic-Key': 'k-cap' }), 'k-cap');
  assert.equal(readStatsKeyFromHeaders({ 'x-yanmusic-key': 'k-low' }), 'k-low');
  assert.equal(readStatsKeyFromHeaders({ other: 'nope' }), '');
  assert.equal(readStatsKeyFromHeaders(undefined), '');
});

test('checkRateLimit：窗口内累计，超限拒绝，跨窗口重置', () => {
  const t0 = 1_000_000;
  let entry: { count: number; windowStart: number } | undefined;
  for (let i = 0; i < PLUGIN_STATS_WRITE_MAX_PER_WINDOW; i += 1) {
    const r = checkRateLimit(entry, t0 + i);
    assert.equal(r.allowed, true, `第 ${i + 1} 次应放行`);
    entry = r.entry;
  }
  const over = checkRateLimit(entry, t0 + PLUGIN_STATS_WRITE_MAX_PER_WINDOW);
  assert.equal(over.allowed, false, '超过窗口上限应拒绝');

  const nextWindow = checkRateLimit(over.entry, t0 + PLUGIN_STATS_WRITE_WINDOW_MS);
  assert.equal(nextWindow.allowed, true, '跨窗口应重置并放行');
  assert.equal(nextWindow.entry.count, 1);
});

test('常量口径：头名与环境变量名不得随意改动（客户端/Worker 契约）', () => {
  assert.equal(PLUGIN_STATS_KEY_HEADER, 'x-yanmusic-key');
  assert.equal(PLUGIN_STATS_KEY_ENV, 'yanmusic_PLUGIN_STATS_API_KEY');
});
