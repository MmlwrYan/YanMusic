import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAllowedTopLevelNavigation } from '../src/shared/navigationPolicy.ts';

/**
 * IMP-12：顶层导航拦截策略。
 *
 * 复现（修复前）：`src/main` 全目录 grep `will-navigate` → 无命中，
 * 即渲染层可被导航到任意页面，而该页面仍持有 preload 暴露的全部能力。
 *
 * 策略必须满足：放行 `file:` / `about:` / dev server 同源，其余一律拒绝（fail-closed）。
 * `webContents.loadURL()` 不触发 `will-navigate`，故窗口创建期加载不受影响。
 */

const DEV_ORIGIN = 'http://localhost:5173';

test('放行 file: 与 about:（生产环境本地页面与内部空白页）', () => {
  assert.equal(isAllowedTopLevelNavigation('file:///C:/app/dist/index.html'), true);
  assert.equal(isAllowedTopLevelNavigation('file:///app/dist/plugin-window.html?pluginId=x'), true);
  assert.equal(isAllowedTopLevelNavigation('about:blank'), true);
});

test('放行 dev server 同源（开发模式页面内相对导航）', () => {
  const policy = { devServerOrigin: DEV_ORIGIN };
  assert.equal(isAllowedTopLevelNavigation('http://localhost:5173/', policy), true);
  assert.equal(isAllowedTopLevelNavigation('http://localhost:5173/main/journal', policy), true);
  // 端口不同视为不同源
  assert.equal(isAllowedTopLevelNavigation('http://localhost:5174/', policy), false);
  // 不同主机
  assert.equal(isAllowedTopLevelNavigation('http://127.0.0.1:5173/', policy), false);
});

test('拒绝一切外部 http(s) 导航', () => {
  assert.equal(isAllowedTopLevelNavigation('https://example.com/'), false);
  assert.equal(isAllowedTopLevelNavigation('https://evil.example.com/phish'), false);
  assert.equal(
    isAllowedTopLevelNavigation('http://localhost:5173/', { devServerOrigin: null }),
    false,
  );
  assert.equal(isAllowedTopLevelNavigation('https://mmlwryan.github.io/YanMusic/share/'), false);
});

test('拒绝危险协议与畸形输入', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    '',
    '   ',
    'not a url',
  ]) {
    assert.equal(isAllowedTopLevelNavigation(url), false, `应拒绝：${url}`);
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(isAllowedTopLevelNavigation(value), false, `应拒绝：${JSON.stringify(value)}`);
  }
});

test('devServerOrigin 为空/非法时不放行任何 http(s)', () => {
  assert.equal(
    isAllowedTopLevelNavigation('http://localhost:5173/', { devServerOrigin: '' }),
    false,
  );
  assert.equal(
    isAllowedTopLevelNavigation('http://localhost:5173/', { devServerOrigin: 'not-a-url' }),
    false,
  );
  assert.equal(
    isAllowedTopLevelNavigation('http://localhost:5173/', { devServerOrigin: '   ' }),
    false,
  );
});

test('应用侧已接入 will-navigate 拦截（防止策略只写不用）', () => {
  const appSource = readFileSync(path.join(repoRoot(), 'src', 'main', 'app.ts'), 'utf8');
  assert.ok(/will-navigate/.test(appSource), 'src/main/app.ts 未注册 will-navigate 拦截');
  assert.ok(/isAllowedTopLevelNavigation/.test(appSource), 'src/main/app.ts 未使用统一导航策略');
  assert.ok(
    /web-contents-created/.test(appSource),
    '应在 web-contents-created 钩子内统一注册（覆盖全部窗口）',
  );
});

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
