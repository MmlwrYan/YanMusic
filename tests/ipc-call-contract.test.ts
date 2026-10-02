import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S-4（v1.3.0）：IPC **调用方式与注册方式必须匹配**。
 *
 * ## 为什么需要这条守卫
 *
 * v1.2.8 修过一个真实缺陷：`update:install` 在 preload 用**单向** `ipcRenderer.send`
 * 发送，主进程却用 `registerHandler`（实现是 `ipcMain.handle`）注册 ——
 * 而 `ipcMain.handle` **只响应 `ipcRenderer.invoke`**，`send` 打上去会被 Electron
 * **静默丢弃**：没有日志、没有异常，用户看到的是「点击立即安装毫无反应」。
 *
 * 当时 `tests/ipc-channel-contract.test.ts` 已有「preload 调用的通道在主进程都有注册
 * （无断链）」守卫 —— 但它的 preload 解析**把 send 与 invoke 混为一类**
 *（`ipcRenderer\.(?:invoke|send)`），因此只能发现「完全没注册」，
 * **发现不了「注册了但方式不对」**。本文件补的正是这一格。
 *
 * ## 判定规则
 *
 * - preload 用 `send` / `sendWithPlainPayload`（单向）→ 主进程必须用
 *   `registerListener` / `ipcMain.on`
 * - preload 用 `invoke` / `invokeWithPlainPayload`（双向）→ 主进程必须用
 *   `registerHandler` / `ipcMain.handle`
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `update:install` 的 `registerListener` 改回 `registerHandler` → 用例 1、2 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const collectMainSources = (): Array<{ rel: string; source: string }> => {
  const results: Array<{ rel: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (!statSync(full).isFile()) continue;
      results.push({
        rel: path.relative(repoRoot, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(path.join(repoRoot, 'src', 'main'));
  return results;
};

/**
 * 剥离注释，避免源码守卫被注释误伤
 *（本批已三次栽在此处：写出完整注册调用的注释、文档里的环境变量示例、注释里提到的标识符）。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '/* stripped */').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

type CallKind = 'send' | 'invoke';

/** preload 主动发起的调用：channel → 调用方式。 */
const preloadCalls = (): Map<string, CallKind> => {
  const source = stripComments(read('src/preload/index.ts'));
  const result = new Map<string, CallKind>();

  const record = (channel: string, kind: CallKind) => {
    const existing = result.get(channel);
    // 同一通道若既有 send 又有 invoke，说明实现有歧义 —— 保留首次并让断言去暴露
    if (!existing) result.set(channel, kind);
  };

  // invoke 类（双向）。注意 `invokeWithPlainPayload<T>(...)` 带泛型。
  for (const m of source.matchAll(
    /(?:ipcRenderer\.invoke|invokeWithPlainPayload(?:<[^>]*>)?)\(\s*'([^']+)'/g,
  )) {
    record(m[1], 'invoke');
  }
  // send 类（单向）
  for (const m of source.matchAll(/(?:ipcRenderer\.send|sendWithPlainPayload)\(\s*'([^']+)'/g)) {
    record(m[1], 'send');
  }
  // 还原被上方 send 模式误吞的 invoke（`ipcRenderer.invoke` 含 `send`? 否 —— 无重叠，此处仅防御）
  return result;
};

/** 主进程的注册：channel → 注册方式。 */
const mainRegistrations = (): Map<string, 'handler' | 'listener'> => {
  const result = new Map<string, 'handler' | 'listener'>();
  const patterns: Array<{ re: RegExp; kind: 'handler' | 'listener' }> = [
    { re: /registerHandler\(\s*'([^']+)'/g, kind: 'handler' },
    { re: /ipcMain\.handle\(\s*'([^']+)'/g, kind: 'handler' },
    { re: /registerListener\(\s*'([^']+)'/g, kind: 'listener' },
    { re: /ipcMain\.on\(\s*'([^']+)'/g, kind: 'listener' },
  ];
  for (const { rel, source } of collectMainSources()) {
    const cleaned = stripComments(source);
    for (const { re, kind } of patterns) {
      for (const m of cleaned.matchAll(re)) {
        if (!result.has(m[1])) result.set(m[1], kind);
        void rel;
      }
    }
  }
  return result;
};

test('S-4：preload 的单向 send 与主进程注册方式必须匹配（v1.2.8 缺陷所属类别）', () => {
  const calls = preloadCalls();
  const registrations = mainRegistrations();

  assert.ok(calls.size > 50, `解析到的 preload 调用过少（${calls.size}）—— 守卫可能失效`);

  const mismatches: string[] = [];
  for (const [channel, kind] of calls) {
    const registered = registrations.get(channel);
    if (registered === undefined) continue; // 「完全未注册」由 ipc-channel-contract 的断链守卫负责
    const expected = kind === 'send' ? 'listener' : 'handler';
    if (registered !== expected) {
      mismatches.push(
        `${channel}：preload 用 ${kind}（${kind === 'send' ? '单向' : '双向'}），` +
          `主进程却用 ${registered}（${registered === 'handler' ? 'ipcMain.handle' : 'ipcMain.on'}）注册`,
      );
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    '以下通道的调用方式与注册方式不匹配 —— 运行期会被 Electron **静默丢弃**' +
      '（无日志、无异常，表现为「点了没反应」）：\n' +
      '  · preload 用 send（单向）→ 主进程必须 registerListener / ipcMain.on\n' +
      '  · preload 用 invoke（双向）→ 主进程必须 registerHandler / ipcMain.handle\n' +
      mismatches.join('\n'),
  );
});

test('S-4：更新链路 5 个通道的契约表（v1.2.8 缺陷的定向回归守卫）', () => {
  // 这 5 条是「检查 → 下载 → 安装」的完整链路。v1.2.8 的缺陷正是 update:install
  // 违反了本表 —— 定向固化，避免通用守卫将来被削弱时该链路失去保护。
  const expected: Array<{ channel: string; call: CallKind; registration: 'handler' | 'listener' }> =
    [
      { channel: 'update:get-state', call: 'invoke', registration: 'handler' },
      // 注意：检查更新用的通道是 `check-for-updates`（无 update: 前缀），
      // 由设置页 setting.ts 的 checkForUpdates() 发起。
      { channel: 'check-for-updates', call: 'send', registration: 'listener' },
      { channel: 'update:download', call: 'send', registration: 'listener' },
      { channel: 'update:cancel-download', call: 'send', registration: 'listener' },
      // ⚠️ v1.2.8 修复点：preload 用 send，故必须是 listener（曾误用 handler → 静默失效）
      { channel: 'update:install', call: 'send', registration: 'listener' },
    ];

  const calls = preloadCalls();
  const registrations = mainRegistrations();
  const problems: string[] = [];

  for (const item of expected) {
    const actualCall = calls.get(item.channel);
    if (actualCall !== item.call) {
      problems.push(
        `${item.channel}: preload 调用方式为 ${actualCall ?? '（未找到）'}，契约要求 ${item.call}`,
      );
    }
    const actualReg = registrations.get(item.channel);
    if (actualReg !== item.registration) {
      problems.push(
        `${item.channel}: 主进程注册方式为 ${actualReg ?? '（未找到）'}，契约要求 ${item.registration}`,
      );
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

test('S-4：更新链路的失败分支必须回传渲染层（不得只有 console/日志）', () => {
  const source = stripComments(read('src/main/ipc/settings.ts'));

  // 安装失败必须经 update-download-status 广播回渲染层（listener 路径无法返回值）
  assert.match(
    source,
    /const failUpdateInstall|function failUpdateInstall/,
    'failUpdateInstall 应存在 —— 安装失败必须有一条统一的回传路径',
  );
  assert.match(
    source,
    /sendToRenderer\(\s*'update-download-status'/,
    '安装/下载失败必须经 update-download-status 回传渲染层，否则用户看不到任何提示（静默失败）',
  );
  // 下载失败分支
  assert.match(
    source,
    /\[Updater\]\s*Download failed/,
    '下载失败必须记录明确日志（便于用户取日志排查）',
  );
  // 安装器未能启动的分支（install() 返回 false 时不抛异常，极易静默）
  assert.match(
    source,
    /install\(\) returned false/,
    'install() 返回 false 时必须有明确处理 —— 该分支不抛异常，最容易变成静默失败',
  );
});
