import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 主进程构建产物的**结构性回归守卫**（v1.2.5）。
 *
 * 复现（v1.2.4 线上事故）：安装包安装后主进程启动即弹
 * 「A JavaScript error occurred in the main process / TypeError: Be is not a function」。
 *
 * 根因是一条链：
 *   1. `logger.ts` 与 `storage` 存在循环依赖
 *      logger -> storage/settings -> storage/kv -> logger；
 *   2. `logger.ts` 在**模块顶层**就调用 `getPersistedLogSettings()`
 *      （`let currentLogSettings = normalizeLogSettings(getPersistedLogSettings())`）；
 *   3. vite-plugin-electron 1.x 在 Vite 8（rolldown）下不再把 `codeSplitting`
 *      转译成 `inlineDynamicImports`，于是主进程被切成
 *      index / settings / app 三个 chunk；
 *   4. rolldown 把每个模块体包成惰性 thunk，切分后 thunk 的求值顺序与源码顺序
 *      不一致 —— logger 的 thunk 先于 storage/settings 求值，栈顶那次顶层调用
 *      拿到 undefined，抛 `TypeError: <minified> is not a function`。
 *
 * 修复分两层，本用例对两层都设闸门：
 *   A. 源码层：`logger.ts` 不得在模块顶层调用跨模块函数（改为惰性求值）；
 *   B. 构建层：主进程必须 `codeSplitting: false` 打成单文件。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** A. logger.ts 顶层不得有跨模块立即调用 */
test('A：logger.ts 不得在模块顶层立即调用 getPersistedLogSettings', () => {
  const source = read('src/main/logger.ts');

  // 匹配形如 `let x = ...getPersistedLogSettings(...)` 的顶层赋值（缩进为 0）
  const topLevelImmediateCall = /^(?:let|const|var)\s+\w+\s*=\s*[^;]*getPersistedLogSettings\s*\(/m;
  assert.ok(
    !topLevelImmediateCall.test(source),
    'logger.ts 又在模块顶层立即调用 getPersistedLogSettings() 了。' +
      'logger 与 storage 之间存在循环依赖，顶层立即求值在 code-splitting 下会拿到 undefined，' +
      '导致主进程启动即崩（TypeError: <minified> is not a function）。请改回惰性求值。',
  );

  // 惰性读取函数必须存在，且确实是 ??= 惰性缓存形态
  assert.ok(
    /currentLogSettingsCache\s*\?\?=\s*normalizeLogSettings\(getPersistedLogSettings\(\)\)/.test(
      source,
    ),
    'logger.ts 的惰性初始化（currentLogSettingsCache ??= ...）缺失 —— 修复被回退了',
  );
});

/** B. 构建配置必须关闭主进程 code splitting */
test('B：vite 配置必须为主进程关闭 code splitting', () => {
  const source = read('vite.config.mts');

  assert.ok(
    /codeSplitting\s*:\s*false/.test(source),
    'vite.config.mts 未为主进程设置 codeSplitting: false —— 主进程会被切成多 chunk，' +
      '循环依赖场景下模块顶层调用可能拿到 undefined',
  );

  // external 列表仍然完整（本次事故期间还发现 rollupOptions 会被插件在 Vite 8 下删除）
  for (const dep of ['electron', 'font-list', 'electron-audio-loopback']) {
    assert.ok(
      source.includes(`'${dep}'`),
      `vite.config.mts 的 external 列表缺失 ${dep}（主进程不应把它打进 bundle）`,
    );
  }
});

/** C. 若已构建，产物必须是单文件（无额外 chunk） */
test('C：已构建的主进程产物必须是单文件', () => {
  const mainDir = path.join(repoRoot, 'dist-electron', 'main');
  if (!existsSync(mainDir)) {
    // 未构建（CI 的 test 作业在 build 之前跑）时跳过，不算失败
    return;
  }

  const entries = readdirSync(mainDir);
  const jsFiles = entries.filter((name) => name.endsWith('.js'));

  assert.ok(jsFiles.includes('index.js'), '主进程入口 index.js 缺失');

  // 单文件产物：除 index.js（以及可选的 .map）外，不应再有其它 .js chunk
  const extraChunks = jsFiles.filter((name) => name !== 'index.js');
  assert.deepEqual(
    extraChunks,
    [],
    `主进程产物出现额外 chunk: ${extraChunks.join(', ')} —— code splitting 未关闭。\n` +
      '这正是 v1.2.4 启动崩溃（TypeError: <minified> is not a function）的构建侧成因。',
  );
});

/** D. 若已构建，产物中不得残留对 storage 模块的顶层立即调用形态 */
test('D：主进程产物中不得残留顶层跨模块立即调用', () => {
  const entry = path.join(repoRoot, 'dist-electron', 'main', 'index.js');
  if (!existsSync(entry)) {
    return;
  }

  const bundle = readFileSync(entry, 'utf8');

  // logger 模块的 thunk 特征：MAX_LOG_SIZE 的编译值 5*1024*1024
  const maxLogSize = '5242880';
  const marker = bundle.indexOf(maxLogSize);
  assert.ok(marker >= 0, '未在主进程产物中找到 logger 模块（MAX_LOG_SIZE 标记缺失）');

  // 取该 thunk 的一段窗口，确认缓存变量初始化为 null 而非立即调用
  const window = bundle.slice(marker, marker + 160);
  assert.ok(
    /=\s*null\s*,/.test(window),
    'logger 模块的 currentLogSettings 缓存初值不是 null —— ' +
      '可能又变回了顶层立即调用（会触发启动崩溃）',
  );
});
