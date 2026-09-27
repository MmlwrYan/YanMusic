import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * M-7 一致性守卫：Worker 是纯 JS 运行环境，无法 import `src/shared/pluginStatsAuth.ts`，
 * 因此鉴权/限流逻辑在 `worker.js` 中**内联重复实现**。
 * 本测试不重复其行为，而是守两条**契约**，防止两侧漂移：
 *   1. 关键常量字面量一致（头名、窗口、上限、secret 名）；
 *   2. `handleEvents` 中鉴权确实在**读 body 之前**执行（否则会先解析不可信输入）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, '../cloudflare/plugin-marketplace-worker/worker.js');
const workerSource = readFileSync(workerPath, 'utf8');

test('worker.js 使用与 src/shared/pluginStatsAuth.ts 一致的头名常量', () => {
  assert.match(workerSource, /const STATS_KEY_HEADER = 'x-yanmusic-key'/);
  assert.match(workerSource, /const WRITE_WINDOW_MS = 60000/);
  assert.match(workerSource, /const WRITE_MAX_PER_WINDOW = 60/);
});

test('worker.js 的 CORS 允许头包含 x-yanmusic-key（否则浏览器端预检失败）', () => {
  const corsMatch = workerSource.match(/access-control-allow-headers':\s*'([^']+)'/);
  assert.ok(corsMatch, '应能定位 corsHeaders');
  assert.ok(
    corsMatch![1].includes('x-yanmusic-key'),
    `CORS allow-headers 必须含 x-yanmusic-key，实际：${corsMatch![1]}`,
  );
});

test('worker.js：写入端点鉴权必须在读取请求体之前执行', () => {
  const eventsStart = workerSource.indexOf('const handleEvents = async');
  assert.ok(eventsStart > -1, '应能定位 handleEvents');
  const bodyStart = workerSource.indexOf('const body = await readJsonBody(request);', eventsStart);
  const authStart = workerSource.indexOf('isWriteAuthorized(', eventsStart);
  const limitStart = workerSource.indexOf('checkRateLimit(', eventsStart);
  assert.ok(authStart > -1, 'handleEvents 必须调用 isWriteAuthorized');
  assert.ok(limitStart > -1, 'handleEvents 必须调用 checkRateLimit');
  assert.ok(bodyStart > -1, 'handleEvents 应读取 body');
  assert.ok(
    authStart < bodyStart,
    '鉴权必须在 readJsonBody 之前——先拒绝未授权请求，再解析不可信输入',
  );
  assert.ok(authStart < limitStart, '应先鉴权再限流');
});

test('worker.js：未配置密钥时 fail closed（isWriteAuthorized 对空 expected 返回 false）', () => {
  // 直接以 worker 源码中的函数语义判断：`if (!want) return false;`
  assert.match(
    workerSource,
    /const isWriteAuthorized[\s\S]*?if \(!want\) return false;/,
    'isWriteAuthorized 必须在 expected 为空时返回 false',
  );
  assert.match(
    workerSource,
    /if \(!isWriteAuthorized\(providedKey, env\.PLUGIN_STATS_WRITE_KEY\)\)/,
    'handleEvents 必须用 env.PLUGIN_STATS_WRITE_KEY 作为期望值',
  );
});

test('worker.js：写入事件仍限三类，且拒绝时返回 401/429', () => {
  assert.match(workerSource, /\['install', 'update', 'failure'\]\.includes\(event\)/);
  assert.match(workerSource, /error: 'unauthorized' \}, \{ status: 401 \}/);
  assert.match(workerSource, /error: 'rate limited' \}, \{ status: 429 \}/);
});
