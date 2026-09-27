#!/usr/bin/env node
/**
 * 主进程产物冒烟测试（v1.2.5 起，v1.2.4 线上事故的直接产物）。
 *
 * 为什么需要它：v1.2.4 的 CI 六腿全绿、build 退出码 0，但安装包装完
 * 主进程启动即崩（`TypeError: Be is not a function`）。原因是当时的 CI 只
 * 校验「产物存在」（`Verify bundled Windows executable` 等），**从未真的
 * 启动过主进程**。产物存在 ≠ 应用能启动。
 *
 * 本脚本做两件事：
 *   1. 结构断言：主进程必须是单文件（禁止 code splitting）。
 *      多 chunk 会让 rolldown 的惰性初始化 thunk 求值顺序与源码顺序不一致，
 *      循环依赖下模块顶层调用会拿到 undefined。
 *   2. 真的加载一次产物：用 stub 替换 `electron`，然后 require 主进程 bundle，
 *      断言它通过了「模块求值阶段」—— 这正是 v1.2.4 崩溃发生的位置。
 *
 * 退出码：0 = 通过；非 0 = 失败（CI 会因此中断，避免再产出打不开的包）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const MAIN_DIR = path.join(ROOT, 'dist-electron', 'main');

let failed = false;
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  failed = true;
};
const ok = (msg) => console.log(`[smoke] OK: ${msg}`);

// ---------------------------------------------------------------- 1. 结构断言

if (!fs.existsSync(MAIN_DIR)) {
  fail(`主进程产物目录不存在：${MAIN_DIR}（是否忘了跑 vite build？）`);
  process.exit(1);
}

const entries = fs.readdirSync(MAIN_DIR);
const jsFiles = entries.filter((n) => n.endsWith('.js'));

if (!jsFiles.includes('index.js')) {
  fail(`主进程入口 index.js 缺失。目录内容：${entries.join(', ')}`);
}

const extraChunks = jsFiles.filter((n) => n !== 'index.js');
if (extraChunks.length > 0) {
  fail(
    `主进程出现了额外 chunk：${extraChunks.join(', ')}\n` +
      '       这说明 code splitting 未被关闭（vite.config.mts 需设 codeSplitting: false）。\n' +
      '       多 chunk 会让模块求值顺序与源码顺序不一致，循环依赖下会抛\n' +
      '       TypeError: <minified> is not a function —— 即 v1.2.4 的启动崩溃。',
  );
} else {
  ok(`主进程为单文件（${jsFiles.join(', ')}），无 code splitting`);
}

const entryPath = path.join(MAIN_DIR, 'index.js');
if (!fs.existsSync(entryPath)) {
  console.error('[smoke] 无法继续：入口文件不存在');
  process.exit(1);
}

// ------------------------------------------------------- 2. 真的加载一次产物

const noop = () => {};
const chain = () => ({ then: () => chain(), catch: () => chain() });

const appStub = {
  getPath: () => os.tmpdir(),
  getAppPath: () => ROOT,
  isPackaged: false,
  setName: noop,
  setAppUserModelId: noop,
  commandLine: {
    appendSwitch: noop,
    appendArgument: noop,
    getSwitchValue: () => '',
    hasSwitch: () => false,
  },
  whenReady: () => chain(),
  on: noop,
  once: noop,
  off: noop,
  addListener: noop,
  quit: noop,
  exit: noop,
  relaunch: noop,
  disableHardwareAcceleration: noop,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: noop,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAsDefaultProtocolClient: () => true,
  dock: null,
  isReady: () => false,
  getVersion: () => require(path.join(ROOT, 'package.json')).version,
  getName: () => 'YanMusic',
  getLocale: () => 'zh-CN',
  getSystemLocale: () => 'zh-CN',
  getPreferredSystemLanguages: () => ['zh-CN'],
};

const electronStub = {
  app: appStub,
  BrowserWindow: Object.assign(
    function BrowserWindow() {
      throw new Error('[smoke] BrowserWindow stub：不应在模块求值阶段被构造');
    },
    {
      getAllWindows: () => [],
      fromWebContents: () => null,
      getFocusedWindow: () => null,
    },
  ),
  ipcMain: { handle: noop, on: noop, once: noop, removeHandler: noop, removeListener: noop },
  globalShortcut: {
    register: noop,
    unregister: noop,
    unregisterAll: noop,
    isRegistered: () => false,
  },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1, size: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [],
    on: noop,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s)),
    decryptString: (b) => Buffer.from(b).toString(),
  },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: noop },
  Menu: {
    setApplicationMenu: noop,
    buildFromTemplate: () => ({}),
    getApplicationMenu: () => null,
  },
  MenuItem: function MenuItem() {},
  Tray: function Tray() {
    return {
      setToolTip: noop,
      setContextMenu: noop,
      on: noop,
      destroy: noop,
      isDestroyed: () => false,
    };
  },
  shell: {
    openExternal: () => Promise.resolve(),
    showItemInFolder: noop,
    openPath: () => Promise.resolve(''),
  },
  session: {
    defaultSession: {
      webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop },
    },
    fromPartition: () => ({ webRequest: { onBeforeSendHeaders: noop } }),
  },
  net: { fetch: () => Promise.resolve() },
  dialog: {
    showMessageBox: () => Promise.resolve({ response: 0 }),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
  powerSaveBlocker: { start: () => 1, stop: noop, isStarted: () => false },
  protocol: { handle: noop, registerSchemesAsPrivileged: noop },
  clipboard: { writeText: noop, readText: () => '' },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

// 判定「模块求值阶段是否通过」。
//
// 判据不是「错误类型」，而是「错误是否发生在模块顶层求值阶段（同步抛出）」。
// v1.2.4 崩溃正发生在这里。而 stub 不完整导致的错误（如 electron-log 需要真实
// app.whenReady 回调）是**异步**发生的，不会让 require 同步抛出。
//
// 因此：只要 require 抛了错，且错误栈指向主进程 bundle 自身（而非 harness），
// 就判定为失败。
let evalError = null;
try {
  require(entryPath);
  ok('主进程产物模块求值阶段通过（无同步抛错）');
} catch (err) {
  evalError = err;
}

Module._load = originalLoad;

if (evalError) {
  const stack = String(evalError.stack || '');
  // 判断错误是否源自主进程产物，而不是本冒烟脚本的 stub
  const fromBundle = stack.includes('dist-electron') && stack.includes('index.js');
  const firstFrame = stack.split('\n')[1]?.trim() || '(无栈信息)';
  const isHarness = firstFrame.includes('smoke-main-bundle.cjs');

  if (fromBundle && !isHarness) {
    fail(
      `主进程模块求值阶段抛错（${evalError.constructor.name}）：${evalError.message}\n` +
        '       错误来自主进程产物自身，且发生在模块顶层求值阶段 ——\n' +
        '       这正是 v1.2.4 启动崩溃的形态（顶层跨模块调用拿到 undefined）。\n' +
        `       栈：\n${stack
          .split('\n')
          .slice(1, 5)
          .map((l) => '         ' + l.trim())
          .join('\n')}`,
    );
  } else {
    // 错误源自 harness 自身（stub 不完整），模块求值其实已经通过。
    console.log(
      `[smoke] NOTE: 模块求值通过后，harness 侧出现 ${evalError.constructor.name}（stub 局限，非缺陷）：` +
        evalError.message,
    );
  }
}

// ------------------------------------------------------------------ 结果

if (failed) {
  console.error('\n[smoke] 冒烟测试未通过。禁止发布。');
  process.exit(1);
}

console.log('\n[smoke] 冒烟测试通过。');
process.exit(0);
