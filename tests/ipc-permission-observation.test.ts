import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifySender,
  configureIpcPermissionLog,
  evaluateIpcCall,
  EXTERNALLY_REGISTERED_CHANNELS,
  IPC_PERMISSION_STRICT_ENV,
  IPC_VIOLATION_LOG_FILENAME,
  isStrictModeEnabled,
  observeIpcCall,
  registerWindowKind,
  resetIpcPermissionObservation,
  scopeForChannel,
  unregisterWindowKind,
} from '../src/main/ipc/permissions.ts';

/**
 * IMP-01 观测机制的守卫。
 *
 * 本轮范围冻结要求「白名单**只观测不拒绝**」。本文件把该红线固化为断言：
 * 默认配置下，任何通道、任何发送方都不得被拒绝；只有显式设置
 * `IPC_PERMISSION_STRICT` 才会拒绝（且默认关闭、本轮不得开启）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const INDEX = 'file:///C:/app/dist/index.html';
const LYRIC = 'file:///C:/app/dist/desktop-lyric.html';
const PLUGIN = 'file:///C:/app/dist/plugin-window.html';

const withTempLog = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ipc-perm-'));
  try {
    resetIpcPermissionObservation();
    configureIpcPermissionLog(dir);
    fn(dir);
  } finally {
    resetIpcPermissionObservation();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
};

const withEnv = (value: string | undefined, fn: () => void) => {
  const previous = process.env[IPC_PERMISSION_STRICT_ENV];
  if (value === undefined) delete process.env[IPC_PERMISSION_STRICT_ENV];
  else process.env[IPC_PERMISSION_STRICT_ENV] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[IPC_PERMISSION_STRICT_ENV];
    else process.env[IPC_PERMISSION_STRICT_ENV] = previous;
  }
};

test('红线：默认配置下任何通道与发送方都不得被拒绝', () => {
  withEnv(undefined, () => {
    const channels = ['app:get-info', 'plugins:data:get', 'mpv:play', 'storage:kv:get', '未知通道'];
    const senders = [INDEX, LYRIC, PLUGIN, 'https://example.com/x.html', '', undefined];
    for (const channel of channels) {
      for (const url of senders) {
        const result = observeIpcCall({ channel, url, webContentsId: 1 });
        assert.equal(result.rejected, false, `不得拒绝调用：channel=${channel} url=${String(url)}`);
      }
    }
  });
});

test('严格模式开关：默认关闭，且只认显式真值', () => {
  assert.equal(isStrictModeEnabled(undefined), false);
  assert.equal(isStrictModeEnabled(''), false);
  assert.equal(isStrictModeEnabled('0'), false, '"0" 不得被当成开启');
  assert.equal(isStrictModeEnabled('false'), false, '"false" 不得被当成开启');
  assert.equal(isStrictModeEnabled('off'), false);
  assert.equal(isStrictModeEnabled('1'), true);
  assert.equal(isStrictModeEnabled('true'), true);
  assert.equal(isStrictModeEnabled(' YES '), true);

  withEnv('1', () => {
    const blocked = observeIpcCall({ channel: 'app:get-info', url: LYRIC, webContentsId: 2 });
    assert.equal(blocked.rejected, true, '显式开启后应拒绝');
    // 但同一次调用仍然会被执行方（registry）在非严格模式下放行 —— 见下一条接线守卫
  });
});

test('发送方判定：index.html 必然 ambiguous（mini 播放器与主窗口同 bundle）', () => {
  const index = classifySender(INDEX);
  assert.deepEqual([...index.kinds].sort(), ['main', 'mini-player']);
  assert.equal(index.ambiguous, true, 'index.html 无法区分主窗口与 mini 播放器');
  assert.equal(index.page, 'index.html');

  const lyric = classifySender(LYRIC);
  assert.deepEqual([...lyric.kinds], ['desktop-lyric']);
  assert.equal(lyric.ambiguous, false);

  const plugin = classifySender(PLUGIN);
  assert.deepEqual([...plugin.kinds], ['plugin-window']);
  assert.equal(plugin.ambiguous, false);

  // 查询串 / hash 不影响判定
  assert.equal(classifySender('file:///C:/app/dist/index.html?x=1#y').page, 'index.html');
  // 未知页面 → 不确定
  assert.equal(classifySender('https://example.com/evil.html').ambiguous, true);
  assert.equal(classifySender('').ambiguous, true);
});

test('作用域表：可推断的收窄，不确定的填 all（all 的比例即设计成熟度）', () => {
  assert.deepEqual(scopeForChannel('app:get-info'), ['main']);
  assert.deepEqual(scopeForChannel('plugins:data:get'), ['main', 'plugin-window']);
  assert.deepEqual(scopeForChannel('share:copy'), ['main', 'plugin-window']);
  assert.deepEqual(scopeForChannel('mpv:play'), ['main', 'mini-player', 'desktop-lyric']);
  assert.deepEqual(scopeForChannel('window-drag:start'), ['main', 'mini-player', 'desktop-lyric']);
  // 未命中规则 → all（不限制）
  assert.equal(scopeForChannel('storage:kv:get'), 'all');
  assert.equal(scopeForChannel('某个未来通道'), 'all');
});

test('判定语义：窗口类型可确定且不在作用域内才算「不允许」；不确定一律放行', () => {
  // 桌面歌词调用仅限主窗口的通道 → 可确定且不在作用域 → 不允许
  const decision = evaluateIpcCall('app:get-info', LYRIC);
  assert.equal(decision.allowed, false);
  assert.equal(decision.ambiguous, false);

  // 插件窗口调用 plugin 数据通道 → 允许
  assert.equal(evaluateIpcCall('plugins:data:get', PLUGIN).allowed, true);

  // index.html 调任何通道 → ambiguous → 一律放行（宁可漏标不可误标）
  assert.equal(evaluateIpcCall('app:get-info', INDEX).allowed, true);
  assert.equal(evaluateIpcCall('app:get-info', INDEX).ambiguous, true);

  // 未知页面 → ambiguous → 放行
  assert.equal(evaluateIpcCall('app:get-info', 'https://x/y.html').allowed, true);
});

test('样本日志：首次必写 violation，重复按 200 次采样写 summary，且字段可分析', () => {
  withTempLog((dir) => {
    const file = path.join(dir, IPC_VIOLATION_LOG_FILENAME);
    // 先制造 1 次不允许的调用（app:get-info 由桌面歌词发起）
    const first = observeIpcCall({ channel: 'app:get-info', url: LYRIC, webContentsId: 7 });
    assert.equal(first.occurrences, 1);
    assert.ok(existsSync(file), '首次违规即应落盘');
    let lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, 'violation');
    assert.equal(record.channel, 'app:get-info');
    assert.equal(record.page, 'desktop-lyric.html');
    assert.equal(record.webContentsId, 7);
    assert.equal(record.ambiguous, false);
    assert.equal(record.strictMode, false);
    assert.equal(record.rejected, false, '非严格模式下必须记录为「未拒绝」');
    assert.ok(String(record.note).includes('still executed'), '日志需写明调用仍被执行');
    assert.ok(typeof record.at === 'string' && !Number.isNaN(Date.parse(record.at)));

    // 重复到采样点：第 200 次应写一条 summary
    let last = first;
    for (let i = 0; i < 240; i += 1) {
      last = observeIpcCall({ channel: 'app:get-info', url: LYRIC, webContentsId: 7 });
    }
    assert.equal(last.occurrences, 241);
    lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const kinds = lines.map((l) => JSON.parse(l).kind);
    assert.equal(kinds.filter((k) => k === 'violation').length, 1, '首次只写一条');
    assert.equal(
      kinds.filter((k) => k === 'violation-summary').length,
      1,
      '第 200 次应写一条汇总（241 次里只有 200 这一个采样点）',
    );

    // 允许的调用不写日志
    const before = readFileSync(file, 'utf8');
    observeIpcCall({ channel: 'storage:kv:get', url: INDEX, webContentsId: 1 });
    assert.equal(readFileSync(file, 'utf8'), before, '允许的调用不得写日志');
  });
});

test('日志写入失败不得影响主流程（未配置目录时静默跳过）', () => {
  resetIpcPermissionObservation();
  const result = observeIpcCall({ channel: 'app:get-info', url: LYRIC, webContentsId: 1 });
  assert.equal(result.rejected, false);
  assert.equal(result.occurrences, 1);
});

test('接线守卫：registry 两条路径都观测，且拒绝路径被严格模式开关守住', () => {
  const registry = read('src/main/ipc/registry.ts');
  assert.ok(registry.includes('observeIpcCall('), 'registry 必须调用 observeIpcCall');
  assert.equal(
    (registry.match(/observeIpcCall\(/g) || []).length,
    2,
    'handler 与 listener 两条路径都要观测',
  );
  assert.ok(
    registry.includes('observation.rejected'),
    '拒绝必须由 observeIpcCall 的判定驱动（其内部再受严格模式开关约束）',
  );

  const app = read('src/main/app.ts');
  assert.ok(app.includes('configureIpcPermissionLog('), 'app.ts 必须注入日志目录');
  assert.ok(app.includes("app.getPath('logs')"), '日志目录应取应用日志目录');

  // 观测模块本身不得静态 import electron（否则纯 Node 下无法单测）
  const permissions = read('src/main/ipc/permissions.ts');
  assert.ok(
    !/from ['"]electron['"]/.test(permissions),
    'permissions.ts 必须保持纯逻辑（不 import electron），以保证可单测',
  );
});

test('如实记录本轮未覆盖的通道：在 ipcRegistry 之外直连注册的 9 个', () => {
  assert.equal(EXTERNALLY_REGISTERED_CHANNELS.length, 9);
  for (const channel of EXTERNALLY_REGISTERED_CHANNELS) {
    assert.ok(
      channel.startsWith('audio-spectrum:') ||
        channel.startsWith('media-control:') ||
        channel.startsWith('thumbar:'),
      `未覆盖清单里的通道应属于已知的直连注册模块：${channel}`,
    );
  }
  const permissions = read('src/main/ipc/permissions.ts');
  assert.ok(
    permissions.includes('EXTERNALLY_REGISTERED_CHANNELS'),
    '未覆盖清单必须写进模块（作为 v1.3.0 的前置条件）',
  );
});

/**
 * M-1 修复守卫（v1.2.4）：用 `webContents.id` 登记表消除「无法区分窗口」的结构性障碍。
 *
 * 修复前的结论是「index.html 必然 ambiguous，因为 mini 播放器与主窗口同 bundle」。
 * 但窗口由主进程创建，类型是**已知事实**。登记后，判定不再依赖 URL 猜测：
 *   - 主窗口的 index.html → 确定 = main
 *   - mini 播放器的 index.html → 确定 = mini-player
 * 于是「白名单对这个维度永远失效」的结论被推翻 —— 两个结构性障碍都不再是障碍。
 */
test('M-1：登记 webContents 后 index.html 不再 ambiguous（主窗口与 mini 可区分）', () => {
  resetIpcPermissionObservation();

  // 未登记时：沿用旧行为（ambiguous）
  const before = classifySender(INDEX, 999);
  assert.equal(before.ambiguous, true, '未登记的 index.html 仍应按 URL 推断为 ambiguous');
  assert.equal(before.via, 'url');

  // 登记主窗口
  registerWindowKind({ id: 101 }, 'main');
  const asMain = classifySender(INDEX, 101);
  assert.equal(asMain.ambiguous, false, '登记后应变为确定');
  assert.equal(asMain.via, 'registry');
  assert.deepEqual(asMain.kinds, ['main']);

  // 登记 mini 播放器（同一个 URL！）
  registerWindowKind({ id: 102 }, 'mini-player');
  const asMini = classifySender(INDEX, 102);
  assert.equal(asMini.ambiguous, false, 'mini 播放器也应是确定的');
  assert.deepEqual(asMini.kinds, ['mini-player']);

  // 同一个 URL、两个 id → 得到两个不同结论：这就是修复的核心证据
  assert.notDeepEqual(asMain.kinds, asMini.kinds);

  resetIpcPermissionObservation();
});

test('M-1：登记表优先于 URL 推断（URL 说 lyric、登记说 main 时以登记为准）', () => {
  resetIpcPermissionObservation();
  registerWindowKind({ id: 201 }, 'main');
  const result = classifySender(LYRIC, 201);
  assert.equal(result.via, 'registry');
  assert.deepEqual(result.kinds, ['main']);

  // 注销后回退到 URL 推断
  unregisterWindowKind(201);
  const fallback = classifySender(LYRIC, 201);
  assert.equal(fallback.via, 'url');
  assert.deepEqual(fallback.kinds, ['desktop-lyric']);

  resetIpcPermissionObservation();
});

test('M-1：作用是「让判定变准」，而不是「立刻拒绝」——默认仍不得拒绝', () => {
  resetIpcPermissionObservation();

  // 桌面歌词窗口（确定类型）调用只属于主窗口的通道 → allowed=false（判定准确了）
  registerWindowKind({ id: 301 }, 'desktop-lyric');
  const decision = evaluateIpcCall('app:get-info', 'file:///C:/dist/desktop-lyric.html', 301);
  assert.equal(decision.ambiguous, false);
  assert.equal(decision.allowed, false, '确定类型且不在作用域内 → allowed=false');

  // 但默认（非严格模式）下仍然必须**放行** —— 本轮红线不变
  const observed = observeIpcCall({
    channel: 'app:get-info',
    url: 'file:///C:/dist/desktop-lyric.html',
    webContentsId: 301,
  });
  assert.equal(observed.allowed, false);
  assert.equal(observed.rejected, false, '默认配置下不得拒绝任何调用');
  assert.equal(isStrictModeEnabled(), false);

  resetIpcPermissionObservation();
});

test('M-1：四个窗口创建点都必须登记自己的类型（防止漏接导致回退到 URL 猜测）', () => {
  const sites: Array<[string, string]> = [
    ['src/main/window.ts', 'main'],
    ['src/main/desktopLyric/window.ts', 'desktop-lyric'],
    ['src/main/pluginWindows.ts', 'plugin-window'],
    ['src/main/miniPlayer.ts', 'mini-player'],
  ];
  for (const [file, kind] of sites) {
    const source = read(file);
    assert.ok(
      new RegExp(`registerWindowKind\\([^,]+,\\s*'${kind}'\\s*\\)`).test(source),
      `${file} 未登记窗口类型 '${kind}'`,
    );
  }
});

test('M-1：登记表必须在 webContents 销毁时自动注销（防 id 复用误判）', () => {
  const permissions = read('src/main/ipc/permissions.ts');
  assert.ok(
    /once\(\s*'destroyed'/.test(permissions),
    'registerWindowKind 未挂 destroyed 事件 —— id 复用后可能把新窗口误判为旧类型',
  );
});
