import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P-1 守卫：通用 `ipcRenderer` 桥**不得**回到 preload 暴露面。
 *
 * ## 为什么这条守卫是本版的核心
 *
 * v1.3.0 的立项理由就是「插件能绕过一切」这条路径。四类窗口均为
 * `contextIsolation: true` + `nodeIntegration: false`（见 main/window.ts、
 * pluginWindows.ts、miniPlayer.ts），插件代码**没有 `require`**，
 * 因此只能经 `contextBridge` 暴露的对象触达 IPC —— 那个唯一入口就是
 * preload 上的通用 `ipcRenderer`（通道名由调用方自由指定）。
 *
 * 于是 `ctx.electron.ipcRenderer.invoke('storage:kv:get', 'pinia:user')`
 * 可整条绕过能力门禁与身份判定。移除该键即**结构性**堵死这条路径。
 *
 * 这条守卫的价值在于**防止它悄悄加回来**：移除后一切照常工作，
 * 若将来有人为了图方便（例如「临时需要一个新通道」）把通用桥加回，
 * 本版的安全收益会**无声失效**，且没有任何其他测试会察觉。
 *
 * ## 断言方式（结构审计，非行为）
 *
 * `preload/index.ts` `import { contextBridge, ipcRenderer } from 'electron'`，
 * 无法在 `node --test` 下加载执行，故只能做源码级断言 —— 此处**如实标注**。
 * 但断言的**目标形态**是明确的：暴露对象的顶层键中不得出现 `ipcRenderer`。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① 在 `preload/index.ts` 的 `exposeInMainWorld('electron', { … })` 里加回
 *     `ipcRenderer: { send, invoke },` → 用例 1 必须变红；
 *  ② 在任一抹渲染层文件里写 `window.electron.ipcRenderer.send('x', null)` → 用例 2 必须变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const PRELOAD = 'src/preload/index.ts';

/** 收集 src/renderer 下所有 .ts / .vue 源码（用于扫裸调用）。 */
const collectRendererSources = (): Array<{ rel: string; source: string }> => {
  const results: Array<{ rel: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|vue)$/.test(entry.name)) continue;
      if (!statSync(full).isFile()) continue;
      results.push({
        rel: path.relative(repoRoot, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(path.join(repoRoot, 'src', 'renderer'));
  return results;
};

/** 从 preload 源码中取出 `exposeInMainWorld('electron', { … })` 的**顶层键**。 */
const exposedTopLevelKeys = (source: string): string[] => {
  const start = source.indexOf("exposeInMainWorld('electron'");
  assert.ok(start >= 0, 'preload 未找到 exposeInMainWorld("electron")');
  const braceStart = source.indexOf('{', start);
  assert.ok(braceStart > start, 'exposeInMainWorld 后未找到对象字面量');

  // 逐字符匹配花括号，取到对象体（跳过字符串与注释里的括号）。
  let depth = 0;
  let end = -1;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > braceStart, 'exposeInMainWorld 对象字面量未闭合');

  const body = source.slice(braceStart + 1, end);
  // 只取**顶层**键：行首恰为 2 空格缩进的 `name:` 形式。
  const keys: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
};

test('P-1：preload 暴露面不得包含通用 ipcRenderer 桥', () => {
  const keys = exposedTopLevelKeys(read(PRELOAD));
  assert.ok(keys.length > 5, `暴露面顶层键解析异常（仅 ${keys.length} 个）—— 守卫可能失效`);
  assert.ok(
    !keys.includes('ipcRenderer'),
    'preload 暴露面出现了通用 ipcRenderer 桥 —— 插件可据此绕过全部能力门禁' +
      '（这是一个可由插件自由指定通道名的越权入口，v1.3.0 已移除，不得加回）',
  );
});

test('P-1：渲染层不得再出现裸 ipcRenderer 调用（应全部走具名域）', () => {
  const offenders: string[] = [];
  for (const { rel, source } of collectRendererSources()) {
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // 跳过注释行（本版在注释中保留了「原为 …ipcRenderer…」的历史说明）
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/ipcRenderer\s*[?.]/.test(line) || /\bipcRenderer\b\s*\./.test(line)) {
        offenders.push(`${rel}:${index + 1}: ${trimmed}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '渲染层仍在直接使用 ipcRenderer —— 通用桥已移除，这些调用在运行期会静默失效（功能哑火）',
  );
});

test('P-1：插件拿到的 electron 对象与宿主暴露面是同一个（故不得含 ipcRenderer）', () => {
  // `plugins/runtime.ts` 的 `electron: window.electron` 是插件触达 preload 的唯一路径。
  // 此处锁定「它确实是 window.electron 本身」，从而「移除暴露面的 ipcRenderer」
  // 等价于「插件也拿不到」—— 这是本版安全收益成立的**推理链**，需固化。
  const runtime = read('src/renderer/plugins/runtime.ts');
  assert.ok(
    /electron:\s*window\.electron/.test(runtime),
    '插件 runtime 不再直接引用 window.electron —— P-1 的推理前提已变，请复核暴露面收窄是否仍成立',
  );
  // 反向确认：runtime 自己不得私自构造通用桥（例如把 ipcRenderer 再包一层）
  const lines = runtime.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    assert.ok(
      !/ipcRenderer/.test(line),
      `runtime.ts:${index + 1} 出现 ipcRenderer：${trimmed} —— 插件侧不得再暴露通用桥`,
    );
  });
});
