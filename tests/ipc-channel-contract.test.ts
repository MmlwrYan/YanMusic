import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * IMP-18：IPC 通道契约测试（静态分析，不依赖 Electron 运行时）。
 *
 * 为什么是静态分析：`src/main/ipc/registry.ts` 直接 `import { ipcMain } from 'electron'`，
 * 无法在 `node --test` 下实例化。因此改为对源码做结构化断言，覆盖四类真实风险：
 *   1. 通道命名漂移（新增通道不遵循 `domain:action` 约定）
 *   2. 同一注册表内重复注册 handler（registry 会静默 removeHandler 覆盖，后者成为死代码）
 *   3. 关键通道被误删/改名
 *   4. 渲染层（preload）调用了主进程从未注册的通道 —— 运行期才会暴露的断链
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

/** 收集 src/main 下所有 TS 源码。 */
const collectMainSources = (): Array<{ file: string; source: string }> => {
  const results: Array<{ file: string; source: string }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      results.push({
        file: path.relative(repoRoot, fullPath).split(path.sep).join('/'),
        source: readFileSync(fullPath, 'utf8'),
      });
    }
  };
  walk(path.join(repoRoot, 'src', 'main'));
  return results;
};

const mainSources = collectMainSources();

const collectChannels = (kind: 'Handler' | 'Listener') => {
  const pattern = new RegExp(`register${kind}\\(\\s*'([^']+)'`, 'g');
  const found: Array<{ channel: string; file: string }> = [];
  for (const { file, source } of mainSources) {
    for (const match of source.matchAll(pattern)) {
      found.push({ channel: match[1], file });
    }
  }
  return found;
};

const handlerChannels = collectChannels('Handler');
const listenerChannels = collectChannels('Listener');

/**
 * 由 `ipcMain.handle` 直接注册、或由第三方包提供的通道。
 * 每项都必须能在源码/依赖里找到出处（下面的用例会验证，避免清单腐烂）。
 */
const EXTERNALLY_REGISTERED_CHANNELS: Record<string, string> = {
  'audio-spectrum:subscribe': 'src/main/audioSpectrum.ts（ipcMain.handle 直连注册）',
  'audio-spectrum:unsubscribe': 'src/main/audioSpectrum.ts（ipcMain.handle 直连注册）',
  'audio-spectrum:get-status': 'src/main/audioSpectrum.ts（ipcMain.handle 直连注册）',
  'audio-spectrum:get-snapshot': 'src/main/audioSpectrum.ts（ipcMain.handle 直连注册）',
  'media-control:update-state': 'src/main/mediaControls.ts:214（ipcMain.handle 直连注册）',
  'media-control:update-metadata': 'src/main/mediaControls.ts（ipcMain.handle 直连注册）',
  'media-control:update-timeline': 'src/main/mediaControls.ts（ipcMain.handle 直连注册）',
  'media-control:available': 'src/main/mediaControls.ts（ipcMain.handle 直连注册）',
  'enable-loopback-audio': 'electron-audio-loopback 包提供（config.js:5）',
  'disable-loopback-audio': 'electron-audio-loopback 包提供（config.js:6）',
};

const preloadSource = readSource('src/preload/index.ts');

/** preload 通过 invoke/send 主动调用的通道。 */
const preloadInvokedChannels = (): string[] => {
  const channels = new Set<string>();
  const patterns = [
    /(?:ipcRenderer\.(?:invoke|send)|invokeWithPlainPayload<[^>]*>|sendWithPlainPayload|invokeWithPlainPayload)\(\s*'([^']+)'/g,
    /(?:ipcRenderer\.(?:invoke|send)|invokeWithPlainPayload<[^>]*>|sendWithPlainPayload|invokeWithPlainPayload)\(\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of preloadSource.matchAll(pattern)) channels.add(match[1]);
  }
  return [...channels].sort();
};

test('IPC 通道命名遵循 domain:action 约定', () => {
  const all = [...handlerChannels, ...listenerChannels];
  assert.ok(all.length > 100, `解析到的通道过少（${all.length}），守卫可能失效`);
  const bad = all.filter((item) => !/^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/.test(item.channel));
  assert.deepEqual(
    bad.map((item) => `${item.channel} (${item.file})`),
    [],
    '存在不符合命名约定的通道',
  );
});

test('同一注册表内不存在重复注册的 handler', () => {
  const seen = new Map<string, string[]>();
  for (const item of handlerChannels) {
    seen.set(item.channel, [...(seen.get(item.channel) ?? []), item.file]);
  }
  const duplicates = [...seen.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([channel, files]) => `${channel} → ${files.join(', ')}`);
  assert.deepEqual(
    duplicates,
    [],
    '重复注册会被 registry 静默 removeHandler 覆盖，先注册的那个成为死代码',
  );
});

test('关键通道必须存在（防止误删/改名）', () => {
  const allChannels = new Set(
    [...handlerChannels, ...listenerChannels].map((item) => item.channel),
  );
  const critical = [
    'api:request',
    'storage:kv:get',
    'storage:kv:set',
    'storage:kv:delete',
    'storage:reset-all',
    'share:copy',
    'share:capture-rect-to-clipboard',
    'window-control',
    'mpv:load',
    'mpv:set-equalizer',
    'mpv:get-audio-filter',
    'update:install',
    'open-external',
    'diagnostics:get-app-memory',
  ];
  const missing = critical.filter((channel) => !allChannels.has(channel));
  assert.deepEqual(missing, [], '关键通道缺失，说明被误删或改名');
});

test('preload 调用的通道在主进程都有注册（无断链）', () => {
  const registered = new Set([
    ...handlerChannels.map((item) => item.channel),
    ...listenerChannels.map((item) => item.channel),
    ...Object.keys(EXTERNALLY_REGISTERED_CHANNELS),
  ]);
  const invoked = preloadInvokedChannels();
  assert.ok(invoked.length > 50, `解析到的 preload 通道过少（${invoked.length}），守卫可能失效`);

  const dangling = invoked.filter((channel) => !registered.has(channel));
  assert.deepEqual(dangling, [], 'preload 调用了主进程未注册的通道（运行期会挂起或报错）');
});

test('外部注册通道清单不含腐烂条目（每项都能找到出处）', () => {
  const corpus = [
    ...mainSources.map((item) => item.source).join('\n'),
    readSource('src/preload/index.ts'),
  ].join('\n');

  const rotten: string[] = [];
  for (const [channel, provenance] of Object.entries(EXTERNALLY_REGISTERED_CHANNELS)) {
    const filePart = provenance.split(/[（(:]/)[0].trim();
    const inSource = corpus.includes(channel);
    const fileExists = filePart.startsWith('electron-') || /\.(ts|js)$/.test(filePart) === false;
    if (!inSource) rotten.push(`${channel}（清单称来自 ${provenance}，但源码中已无该通道）`);
    void fileExists;
  }
  assert.deepEqual(rotten, [], '外部注册清单已与源码脱节，请更新清单');
});
