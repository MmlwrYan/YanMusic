import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Linux `libmpv` 环境修复的**启用条件**必须与冒烟脚本的标志一致（v1.4.2）。
 *
 * ## 这条守卫来自一次真实的失败链
 *
 * v1.4.0 的 Linux GUI 冒烟一直失败，最终定位为三层叠加：
 *
 * 1. `src/main/mpv/path.ts` 在 Linux 上**刻意优先用系统 libmpv**
 *    （`preferSystem = true`，理由见该文件注释；`deb` 也依赖 `libmpv2 | libmpv1`）；
 * 2. 系统 libmpv 依赖 libavutil **60**，Electron 内置的是裁剪版 **56**
 *    → 原生 addon 检测到不一致后**主动 abort**；
 * 3. `ensureLinuxMpvEnv()` 本该用 `LD_PRELOAD` 消除这个不一致，
 *    但它原来有一条 `if (!app.isPackaged) return true` ——
 *    而 **CI 跑的是 `electron .`（未打包）**，于是修复**根本没执行**。
 *
 * ⇒ 冒烟覆盖的路径与打包路径**不一致**，它测的不是用户实际走的那条路。
 *
 * ## 守卫要点
 *
 * ① `linuxEnv.ts` 必须含 `YANMUSIC_SMOKE` 这一显式开关
 *    （**不能**靠放宽 `app.isPackaged` 的语义 —— 那会让「未打包」与「已打包」
 *    的区别含糊掉）；
 * ② 开关**不能**反过来让 CI 之外也默认生效（即必须仍是 `isPackaged || SMOKE`）；
 * ③ `scripts/smoke-gui.cjs` 必须**真的设置**这个标志 ——
 *    两边名字不一致的话，`linuxEnv` 永远等不到它，而**测试还是绿的**
 *    （因为断言写在别处）。这条是本守卫存在的主要理由。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linuxEnvSource = readFileSync(path.join(repoRoot, 'src/main/mpv/linuxEnv.ts'), 'utf8');
const smokeSource = readFileSync(path.join(repoRoot, 'scripts/smoke-gui.cjs'), 'utf8');

const SMOKE_FLAG = 'YANMUSIC_SMOKE';

test('v1.4.2 ①：linuxEnv 必须以「未打包但冒烟」为条件启用环境修复', () => {
  assert.ok(
    linuxEnvSource.includes(SMOKE_FLAG),
    `src/main/mpv/linuxEnv.ts 必须识别 \`${SMOKE_FLAG}\` 这个显式冒烟开关 —— ` +
      '否则 CI（跑 electron .，未打包）会跳过 LD_PRELOAD 修复，' +
      '冒烟就测不到用户实际走的那条路径',
  );

  // 必须仍是「已打包 或 冒烟」——不能变成无条件执行
  const predicate = linuxEnvSource.match(/const shouldRunEnvFix = \(\) =>([^;]+);/);
  assert.ok(predicate, '应存在 shouldRunEnvFix 谓词（便于本地审计其语义）');
  const body = predicate[1];
  assert.match(body, /app\.isPackaged/, '谓词必须仍包含 app.isPackaged 条件');
  assert.match(
    body,
    new RegExp(SMOKE_FLAG),
    `谓词必须包含 ${SMOKE_FLAG} 条件，且与 isPackaged 是「或」的关系`,
  );
  assert.ok(
    !/^\s*true\s*$/.test(body.trim()),
    '谓词不得退化为无条件 true —— 那会让开发环境也被强制 relaunch',
  );
});

test(`v1.4.2 ②：冒烟脚本必须真的设置 ${SMOKE_FLAG}`, () => {
  assert.ok(
    smokeSource.includes(`${SMOKE_FLAG}: '1'`),
    `scripts/smoke-gui.cjs 必须真的把 \`${SMOKE_FLAG}\` 设为 '1' 传给它启动的 Electron —— ` +
      '否则 linuxEnv.ts 里那个开关永远等不到，而两边各自看都没问题（正是最难发现的形态）',
  );
});

test('v1.4.2 ③：未打包时不得无条件跳过（原来的写法必须已消失）', () => {
  assert.ok(
    !/if \(!app\.isPackaged\) return true;/.test(linuxEnvSource),
    '原来的 `if (!app.isPackaged) return true;` 必须已被替换为基于 shouldRunEnvFix() 的判断 —— ' +
      '那正是导致 CI 跳过多余修复、进而「启动即崩」的那一行',
  );
});
