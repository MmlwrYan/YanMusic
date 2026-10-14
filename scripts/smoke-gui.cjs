/**
 * GUI 端到端冒烟（V4-05 / V4-06，v1.4.0）。
 *
 * ## 它防什么
 *
 * 长期缺口（`KNOWN-DEBT.md`）：
 *   **「CI 全绿 + build 退出码 0」不等于「应用能启动」** —— v1.2.4 就栽在这里：
 *   安装包装完主进程启动即崩，而当时 CI 全绿，因为**没有任何一步真的启动过应用**。
 *
 * 已有的 `scripts/smoke-main-bundle.cjs` 只覆盖**模块顶层求值**（用 stub 替换
 * electron 后 require 主进程 bundle），**没有窗口、没有渲染层**。
 * 本脚本补上真正的一步：**启动 Electron、等主窗口就绪、读首屏 DOM**。
 *
 * ## 判定方式刻意用「结构化断言」而不是截图比对
 *
 * 像素比对在 CI 上必然 flaky（字体、GPU、主题、DPI 都会变），且失败时无法定位。
 * 这里断言的是：
 *   ① 进程在超时内**没有退出**（崩了会立刻退，退出码非 0）；
 *   ② 主窗口页面成为 CDP target 且 URL 命中 `dist/index.html`；
 *   ③ 首屏 DOM **真的渲染出了内容**（侧边栏文案 / 应用根节点非空）——
 *      这一条能抓到「白屏」；
 *   ④ 主进程日志里**没有** fatal 级错误摘要。
 *
 * ## 用法
 *
 *   node scripts/smoke-gui.cjs            # 默认 60s 超时
 *   node scripts/smoke-gui.cjs --timeout=90000
 *   node scripts/smoke-gui.cjs --keep     # 不停杀进程（本机调试用）
 *
 * 退出码：0 = 通过；1 = 失败（失败时会打印已采集到的日志尾部，便于定位）。
 */

const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const DEBUG_PORT = Number(process.env.SMOKE_DEBUG_PORT || 9333);

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TIMEOUT_MS = Number(argOf('timeout', '120000'));
const KEEP = args.includes('--keep');

/**
 * 「已挂载」的判据：应用根节点存在、有子节点、且有可见文本。
 *
 * ⚠️ **刻意不要求「已登录」**。实测（本机，2026-10-14）本脚本第一版要求首屏出现
 * 「发现音乐 / 为您推荐」等主界面文案，结果**在 CI/离线环境下必然假失败**：
 * 应用启动后要走「设备注册 → 拉用户 → 拉设置」才能进主界面，网络不可用时
 * 它会停在加载/错误页（日志实测出现过 `Device init failed: device register failed`）。
 *
 * 冒烟要守的是**「应用能启动且界面渲染出来了」**，不是**「登录成功」** ——
 * 后者依赖外部服务，放进 CI gate 只会制造 flaky。
 */
const MOUNTED_MARKERS = [
  // 主界面（已登录 / 有缓存）
  '发现音乐',
  '为您推荐',
  '我的乐库',
  '插件',
  // 启动加载页（实测文案，2026-10-14）—— 这是**正常中间态**：
  // 应用要先「注册设备 → 拉用户/设置」才进主界面，网络慢时会停在这里数秒到数十秒。
  '引擎就绪',
  '正在注册设备信息',
  '正在开启音乐世界',
  '音为你而生',
  'MUSIC',
  // 需登录 / 出错 / 重试等**非崩溃**状态同样算「已挂载」
  '登录',
  '扫码',
  '出错',
  '重试',
];

/** 主界面文案：只有真的进了主界面才要求出现（用于给出更强的正向证据）。 */
const HOME_MARKERS = ['发现音乐', '为您推荐', '我的乐库', '插件'];

const log = (msg) => console.log(`[smoke-gui] ${msg}`);

/**
 * **前置检查：Node 版本必须 ≥ 22。**
 *
 * 本脚本用**全局 `WebSocket`** 直连 CDP（`--remote-debugging-port`），
 * 而这个全局对象**只有 Node ≥ 22 才有**（Node 20 上是 `undefined`）。
 *
 * ⚠️ 这个坑第一次干跑就踩到了：CI 在 `Restore Node.js for packaging` 之后
 * 用的是 **Node 20**，于是四腿（macOS x64/arm64、Windows x64/arm64）
 * 全部以 `ReferenceError: WebSocket is not defined` 失败。
 * 修法是**在跑本脚本前装 Node 24**（见 `.github/workflows/build.yml` 的
 * `Setup Node.js for GUI smoke`），而不是让本脚本自带一个 WebSocket 实现 ——
 * 那要自己处理握手、掩码与分帧，是多余的复杂度与新的可失败面。
 *
 * 这里显式检查并给出**可操作**的提示：不这样做的话，失败信息只是
 * `WebSocket is not defined` 加一堆栈，读的人得自己去推断是版本问题。
 */
if (typeof WebSocket !== 'function') {
  console.error(
    `[smoke-gui] ❌ 需要 Node ≥ 22（当前 ${process.version}）：本脚本用全局 \`WebSocket\` 直连 CDP，` +
      '而该全局对象在 Node 20 上不存在。\n' +
      '[smoke-gui]    请用 Node 24 跑本脚本（CI 里由 `Setup Node.js for GUI smoke` 步骤保证）。',
  );
  process.exit(1);
}

const electronBinary = () => {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', exe),
    path.join(ROOT, 'node_modules', '.pnpm'),
  ];
  if (existsSync(candidates[0])) return candidates[0];
  // 退一步：走 electron 包的 index.js 导出（各平台布局不同时兜底）
  try {
    const resolved = require(path.join(ROOT, 'node_modules', 'electron'));
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved;
  } catch {
    /* 下面统一报错 */
  }
  return candidates.find((c) => existsSync(c)) || '';
};

/** 轮询 CDP 的 /json/list，直到出现主窗口页面。 */
const waitForPageTarget = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
};

/** 连上页面 target，跑一次 Runtime.evaluate。 */
const evaluateInPage = async (page, expression) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, { resolve });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  // 顺带抓一张截图作为**失败时的诊断证据**（不做像素比对）
  let screenshot = '';
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    screenshot = shot?.data ?? '';
  } catch {
    /* 截图失败不影响判定 */
  }

  ws.close();
  return { value: result?.result?.value, exception: result?.exceptionDetails, screenshot };
};

const main = async () => {
  const binary = electronBinary();
  if (!binary) {
    console.error('[smoke-gui] ❌ 找不到 Electron 二进制 —— 先跑 scripts/setup-local-runtime.ps1');
    process.exit(1);
  }
  log(`Electron: ${binary}`);

  const mainBundle = path.join(ROOT, 'dist-electron', 'main', 'index.js');
  const rendererIndex = path.join(ROOT, 'dist', 'index.html');
  if (!existsSync(mainBundle) || !existsSync(rendererIndex)) {
    console.error(
      '[smoke-gui] ❌ 缺少构建产物（dist-electron/main/index.js 或 dist/index.html）—— 先跑构建',
    );
    process.exit(1);
  }

  // 隔离 userData，避免污染开发者本机配置；也避免单实例锁把冒烟顶掉
  const userDataDir = path.join(
    os.tmpdir(),
    `yanmusic-smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(userDataDir, { recursive: true });

  const logs = [];
  const env = { ...process.env, YANMUSIC_SMOKE: '1' };
  // 这两个是本机坑：ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node；
  // 单实例锁会让第二个实例直接退出（本机常有用户自己的实例在跑）。
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    binary,
    ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDataDir}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const collect = (buf) => {
    const text = buf.toString();
    logs.push(text);
    if (logs.length > 4000) logs.splice(0, 2000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  const cleanup = () => {
    if (KEEP) return;
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };

  const fail = (reason) => {
    console.error(`[smoke-gui] ❌ ${reason}`);
    if (exitInfo)
      console.error(`[smoke-gui]    进程退出：code=${exitInfo.code} signal=${exitInfo.signal}`);
    console.error('[smoke-gui] ---- 日志尾部 ----');
    console.error(logs.join('').slice(-6000));
    cleanup();
    process.exit(1);
  };

  // ① 进程必须活着
  await new Promise((r) => setTimeout(r, 3000));
  if (exited) {
    fail('应用在启动后 3 秒内就退出了（很可能是启动即崩）');
    return;
  }

  // ② 主窗口页面必须成为 CDP target
  const page = await waitForPageTarget(TIMEOUT_MS - 3000);
  if (!page) {
    fail(`等待主窗口页面超时（${TIMEOUT_MS}ms 内未出现 CDP page target）`);
    return;
  }
  log(`主窗口 target: ${page.url}`);

  // ③ 必须是我们的渲染层页面（不是 devtools / 其它）
  if (!/dist\/index\.html|index\.html/.test(page.url)) {
    fail(`主窗口 URL 不含 index.html，实际为：${page.url}`);
    return;
  }

  // ④ 首屏 DOM 必须真的渲染出内容（这一条抓「白屏」）
  //
  // ⚠️ **必须轮询等待挂载**，不能在拿到 CDP target 后立刻断言：
  // 实测（本机，2026-10-14）初次实现就是这么写的，结果是**假失败** ——
  // CDP target 在 `dist/index.html` 开始加载的瞬间就出现了，而 Vue 应用此时
  // 还没挂载（#app 为空、innerText 为 0 字）。真正的启动序列是
  // 「窗口创建 → 加载页面 → 引擎/API 就绪 → 拉用户与设置 → 渲染首屏」，
  // 中间有数秒异步等待。
  //
  // 这个假失败恰好印证了本步骤存在的理由：**「能连上页面」与「首屏渲染出来了」
  // 是两件事** —— 只断言前者会漏掉白屏。
  const domProbeExpression = `(() => {
     const root = document.getElementById('app');
     const text = (document.body && document.body.innerText) || '';
     return JSON.stringify({
       hasAppRoot: !!root,
       appChildCount: root ? root.children.length : 0,
       textLength: text.length,
       sample: text.slice(0, 400),
       title: document.title,
       hash: location.hash,
     });
   })()`;

  const domDeadline = Date.now() + TIMEOUT_MS;
  let dom = null;
  let probe = null;
  let lastState = '(尚未探测)';
  while (Date.now() < domDeadline) {
    probe = await evaluateInPage(page, domProbeExpression);
    if (probe.exception) {
      fail(`渲染层求值抛错：${JSON.stringify(probe.exception).slice(0, 500)}`);
      return;
    }
    try {
      dom = JSON.parse(probe.value);
    } catch {
      fail(`无法解析渲染层探测结果：${String(probe.value).slice(0, 300)}`);
      return;
    }
    if (dom.hasAppRoot && dom.appChildCount > 0 && dom.textLength >= 20) break;
    lastState = `appRoot=${dom.hasAppRoot} children=${dom.appChildCount} textLen=${dom.textLength}`;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (probe.exception) {
    fail(`渲染层求值抛错：${JSON.stringify(probe.exception).slice(0, 500)}`);
    return;
  }

  log(`DOM: appRoot=${dom.hasAppRoot} children=${dom.appChildCount} textLen=${dom.textLength}`);

  if (!dom.hasAppRoot) {
    fail(`等到超时仍找不到 #app 根节点 —— 渲染层没有挂载（最后状态：${lastState}）`);
    return;
  }
  if (dom.appChildCount === 0) {
    fail(`#app 下没有任何子节点 —— 白屏（Vue 应用未挂载）。最后状态：${lastState}`);
    return;
  }
  if (dom.textLength < 20) {
    fail(`首屏文本过短（${dom.textLength} 字）—— 疑似白屏。最后状态：${lastState}`);
    return;
  }

  // ④b 必须命中「已挂载」文案 —— 仅靠 appChildCount 不足以排除
  //     「挂了一个空壳 / 停在纯骨架」这类形态。
  const mountedHit = MOUNTED_MARKERS.filter((m) => dom.sample.includes(m));
  if (mountedHit.length === 0) {
    fail(
      `首屏未出现任何已挂载特征文案（期望其中之一：${MOUNTED_MARKERS.join(' / ')}）—— ` +
        `实际样本：${dom.sample.slice(0, 200)}`,
    );
    return;
  }

  // ④c 如果进到了主界面，给出更强的正向证据（**不作为失败条件** —— 见 MOUNTED_MARKERS 注释）
  const homeHit = HOME_MARKERS.filter((m) => dom.sample.includes(m));
  if (homeHit.length > 0) {
    log(`已进入主界面，文案命中：${homeHit.join(' / ')}`);
  } else {
    log(
      `未进入主界面（命中：${mountedHit.join(' / ')}）—— ` +
        `判定为「已挂载但未登录/加载中/离线」，**不视为失败**（冒烟只守「能启动且渲染出来」）`,
    );
    log(`hash=${dom.hash} textLen=${dom.textLength}`);
  }

  // ⑤ 主进程不得有 fatal 级错误
  const joined = logs.join('');
  const fatalPatterns = [
    /\[fatal\]/i,
    /uncaughtException/i,
    /Failed to load|did-fail-load/i,
    /is not a function/i,
  ];
  const fatalHits = fatalPatterns.filter((re) => re.test(joined));
  if (fatalHits.length) {
    fail(`主进程日志命中 fatal 特征：${fatalHits.map(String).join(', ')}`);
    return;
  }

  // 截图留档（失败时由 CI 上传；成功时也留一张便于人工复核）
  if (probe.screenshot) {
    const shotDir = path.join(ROOT, 'smoke-artifacts');
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(path.join(shotDir, 'first-screen.png'), Buffer.from(probe.screenshot, 'base64'));
    log('已保存首屏截图：smoke-artifacts/first-screen.png');
  }

  cleanup();
  log('✅ GUI 冒烟通过：主窗口已创建、渲染层已挂载、首屏有内容、无 fatal 日志');
  process.exit(0);
};

main().catch((error) => {
  console.error(`[smoke-gui] ❌ 冒烟脚本自身异常：${error?.stack || error}`);
  process.exit(1);
});
