/**
 * 零引用模块扫描（只读，不修改仓库）
 *
 * 用途：找出「从应用入口出发不可达」的源文件，作为删除死代码的依据与守卫。
 *
 * 用法：
 *   node scripts/scan-dead-modules.mjs            # 文本输出
 *   node scripts/scan-dead-modules.mjs --json     # 机器可读
 *   或以模块方式 import { scanDeadModules }        # 供 tests/source-level-guards.test.ts 直接调用
 *
 * 口径（务必阅读，三种分类的处置方式完全不同）：
 *   A 类 = 应用入口不可达 + 未被 import.meta.glob 覆盖 + 未被 tests 引用  → 可删（删除前仍需人工确认）
 *   B 类 = 被 import.meta.glob 覆盖                                      → 插件 API 面，不可删
 *   T 类 = 仅被 tests/ 引用                                             → 契约锚点，不可删（应改为被生产代码引用）
 *
 * 已知边界（不构成「绝对没有引用」的证明）：
 *   1. 运行时字符串拼接的动态导入无法静态解析 → 删除前必须 grep 三串（文件名 / 相对路径 / 别名）复核；
 *   2. `.d.ts` 与 SFC 的类型增强文件没有 import 边，但删除可能让 vue-tsc 报错 → 删除后必须实跑类型检查；
 *   3. `<style src="...">` 已纳入解析；`<style>` 内的 `@import` 未纳入（本项目未使用该写法）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(selfPath), '..');
const SRC = path.join(ROOT, 'src');
const RENDERER = path.join(SRC, 'renderer');
const TESTS = path.join(ROOT, 'tests');

const EXTS = new Set(['.ts', '.vue', '.js', '.mjs', '.css']);

/** 应用入口：可达性分析的起点（新增入口必须同步到这里） */
const ENTRIES = [
  'src/renderer/main.ts', // index.html（主窗口 + mini 播放器共用）
  'src/main/index.ts', // 主进程
  'src/desktop-lyric/main.ts', // desktop-lyric.html
  'src/plugin-window/main.ts', // plugin-window.html
  'src/preload/index.ts', // preload（四窗口共用）
];

/**
 * import.meta.glob 的覆盖目录（数组/多行写法无法用单行正则捕获，人工固化）。
 * 来源：
 *   - src/renderer/plugins/kugou.ts:16     → '../api/*.ts'
 *   - src/renderer/plugins/runtime.ts:1744 → ['../components/ui/*.vue', '../components/music/*.vue', '../components/player/*.vue']
 */
const GLOB_DIRS = [
  { dir: path.join(RENDERER, 'api'), ext: '.ts' },
  { dir: path.join(RENDERER, 'components', 'ui'), ext: '.vue' },
  { dir: path.join(RENDERER, 'components', 'music'), ext: '.vue' },
  { dir: path.join(RENDERER, 'components', 'player'), ext: '.vue' },
];

// 拆成两条分支，**「无 from」的副作用导入必须放在前面**：
// 否则 `import './style.css';` 会被带 `from` 的那条惰性分支一路吞到下一个 `from` 处而漏掉。
// 前缀用 `[\s;{}()]+`（而不是单个字符）：CRLF 文件里 `;\r\nimport` 之间有两个空白字符。
const IMPORT_RE =
  /(?:^|[\s;{}()]+)(?:import|export)\s+['"]([^'"]+)['"]|(?:^|[\s;{}()]+)(?:import|export)\s[\s\S]*?\bfrom\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const STYLE_SRC_RE = /<style[^>]*\ssrc\s*=\s*['"]([^'"]+)['"]/g;

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
};

const CANDIDATE_EXTS = ['.ts', '.vue', '.js', '.mjs', '.css'];

const resolve = (spec, fromFile) => {
  let base;
  if (spec.startsWith('@/')) base = path.join(RENDERER, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // 第三方包 / node: 内置
  for (const c of [
    base,
    ...CANDIDATE_EXTS.map((e) => base + e),
    ...['.ts', '.vue', '.js'].map((e) => path.join(base, 'index' + e)),
  ]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
};

const collectEdges = (file) => {
  const code = fs.readFileSync(file, 'utf8');
  const targets = new Set();
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(code))) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const t = resolve(spec, file);
    if (t) targets.add(t);
  }
  STYLE_SRC_RE.lastIndex = 0;
  while ((m = STYLE_SRC_RE.exec(code))) {
    const t = resolve(m[1], file);
    if (t) targets.add(t);
  }
  return targets;
};

const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').length;
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/** 主逻辑：返回分类结果（纯读取，无副作用） */
export const scanDeadModules = () => {
  const srcFiles = walk(SRC).sort();
  const testFiles = walk(TESTS);

  const edges = new Map();
  for (const f of srcFiles) edges.set(f, collectEdges(f));

  // 测试引用（T 类判定）
  const testRefs = new Set();
  for (const f of testFiles) for (const t of collectEdges(f)) testRefs.add(t);

  // BFS
  const reachable = new Set();
  const queue = ENTRIES.map((e) => path.join(ROOT, e)).filter((p) => fs.existsSync(p));
  const missingEntries = ENTRIES.filter((e) => !fs.existsSync(path.join(ROOT, e)));
  while (queue.length) {
    const f = queue.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const t of edges.get(f) ?? []) if (!reachable.has(t)) queue.push(t);
  }

  const isGlobCovered = (f) =>
    GLOB_DIRS.some((g) => path.dirname(f) === g.dir && path.extname(f) === g.ext);

  const dead = srcFiles.filter((f) => !reachable.has(f));
  const A = dead.filter((f) => !isGlobCovered(f) && !testRefs.has(f));
  const B = dead.filter((f) => isGlobCovered(f) && !testRefs.has(f));
  const T = dead.filter((f) => testRefs.has(f));

  return {
    scanned: srcFiles.length,
    reachable: reachable.size,
    unreachable: dead.length,
    missingEntries,
    A: A.map((f) => ({ file: rel(f), lines: lines(f) })),
    B: B.map((f) => ({ file: rel(f), lines: lines(f) })),
    T: T.map((f) => ({ file: rel(f), lines: lines(f) })),
  };
};

/** CLI 入口：仅当本文件被直接执行时运行 */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === selfPath;
if (isDirectRun) {
  const r = scanDeadModules();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const print = (title, arr) => {
      const total = arr.reduce((s, f) => s + f.lines, 0);
      console.log(`\n== ${title}: ${arr.length} 个 / ${total} 行 ==`);
      for (const f of arr) console.log(`  ${String(f.lines).padStart(5)}  ${f.file}`);
    };
    console.log(`扫描源文件 ${r.scanned}，可达 ${r.reachable}，不可达 ${r.unreachable}`);
    if (r.missingEntries.length)
      console.log(`⚠️ 入口缺失（请修正 ENTRIES）：${r.missingEntries.join(', ')}`);
    print('A 类 真零引用（可删，删除前仍须人工确认）', r.A);
    print('B 类 插件 API 面（import.meta.glob 覆盖，不可删）', r.B);
    print('T 类 仅测试引用（契约锚点，不可删）', r.T);
  }
}
