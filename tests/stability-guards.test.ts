import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ERR_ABORTED, isRecoverableLoadFailure } from '../src/shared/loadFailurePolicy.ts';

/**
 * v1.3.0 稳定性守卫（S-1 / S-2）。
 *
 * 与 W 系列守卫的区别：这里尽量**做成真行为断言**，源码级断言只用在「无法在 node 下
 * 运行」的地方（主进程模块 import electron）。项目在 v1.2.9 的教训是：只断言字符串
 * 存在的守卫没有鉴别力（把逻辑短路掉它仍然是绿的），因此每条都注明**怎样改会变红**。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * S-2 的判定策略：真行为单测（不是源码正则）。
 *
 * 怎样改会变红：把 `isRecoverableLoadFailure` 改成只看 `isMainFrame`（不看
 * errorCode）→ 第二条用例变红；改成恒 true → 前两条都变红。
 */
test('S-2：只有「主框架 + 非 ERR_ABORTED」的加载失败才应触发恢复', () => {
  assert.equal(
    isRecoverableLoadFailure(true, -105),
    true,
    '主框架真实失败必须处理（否则用户看到白窗口）',
  );
  assert.equal(
    isRecoverableLoadFailure(true, ERR_ABORTED),
    false,
    'ERR_ABORTED 是导航被打断（正常现象），处理它会让用户被无意义的弹框骚扰',
  );
  assert.equal(
    isRecoverableLoadFailure(false, -105),
    false,
    '子 iframe 失败与用户要看的界面无关，不应打扰用户',
  );
  assert.equal(isRecoverableLoadFailure(false, ERR_ABORTED), false);
});

/**
 * S-1：主进程必须安装未捕获异常兜底，且兜底必须真的注册了 handler。
 *
 * 怎样改会变红：删掉 `app.ts` 里的 `installFatalErrorGuard()` 调用 → 第一条变红；
 * 删掉 `fatalErrorGuard.ts` 里任一 `process.on(...)` → 第二/三条变红。
 */
test('S-1：主进程必须在最早期安装未捕获异常兜底', () => {
  const app = read('src/main/app.ts');
  assert.ok(
    /installFatalErrorGuard\(\);/.test(app),
    'app.ts 未调用 installFatalErrorGuard() —— 主进程未捕获异常会让应用凭空消失且日志来不及落盘',
  );
  assert.ok(
    /import \{ installFatalErrorGuard \} from '\.\/fatalErrorGuard';/.test(app),
    'installFatalErrorGuard 必须从 fatalErrorGuard 模块导入（而不是在 app.ts 里内联重写一份）',
  );

  const guard = read('src/main/fatalErrorGuard.ts');
  assert.ok(
    /process\.on\('uncaughtException'/.test(guard),
    'fatalErrorGuard 未注册 uncaughtException',
  );
  assert.ok(
    /process\.on\('unhandledRejection'/.test(guard),
    'fatalErrorGuard 未注册 unhandledRejection',
  );
  assert.ok(
    /writeFileSync\(/.test(guard),
    '崩溃摘要必须用同步写（异步写在「即将退出」时不可靠，日志队列会随进程一起丢）',
  );
  assert.ok(
    /app\.exit\(1\)/.test(guard),
    'uncaughtException 必须以非 0 退出码退出 —— 不能吞掉异常继续跑（状态已不可信）',
  );
  assert.ok(
    /handlingFatal/.test(guard),
    '必须有递归保护（handler 自身再抛错时要直接退出，不能形成死循环）',
  );
});

/**
 * S-2：四个窗口都必须接入加载失败恢复。
 *
 * 怎样改会变红：删掉任一文件里的 `attachLoadFailureRecovery(` 调用 → 变红。
 * （用 `for` 逐个断言，失败信息能直接指出是哪个窗口漏了。）
 */
test('S-2：四个窗口都必须接入加载失败恢复', () => {
  const windows = [
    'src/main/window.ts',
    'src/main/pluginWindows.ts',
    'src/main/miniPlayer.ts',
    'src/main/desktopLyric.ts',
  ];
  for (const file of windows) {
    const source = read(file);
    assert.ok(
      /attachLoadFailureRecovery\(/.test(source),
      `${file} 未接入 attachLoadFailureRecovery() —— 该窗口加载失败时会是白窗口、无提示、无重试`,
    );
    assert.ok(
      /from '\.\/loadFailureRecovery'/.test(source),
      `${file} 必须从 loadFailureRecovery 导入（而不是各写一份）`,
    );
  }
});

/**
 * S-2：辅助窗口（mini / 桌面歌词）不得弹模态框。
 *
 * 它们常常没有焦点，`dialog.showMessageBox(win, ...)` 会变成**看不见的模态框**，
 * 把整个应用卡住 —— 这比白窗口更糟。
 *
 * 怎样改会变红：把这两个窗口的 `promptUser` 改成 `true` → 变红。
 */
test('S-2：无焦点的辅助窗口必须走「自动重载」而不是弹框', () => {
  for (const file of ['src/main/miniPlayer.ts', 'src/main/desktopLyric.ts']) {
    const source = read(file);
    const call = source.match(/attachLoadFailureRecovery\([^)]*\)/s);
    assert.ok(call, `${file} 未找到 attachLoadFailureRecovery 调用`);
    assert.ok(
      /promptUser:\s*false/.test(call[0]),
      `${file} 的辅助窗口必须 promptUser: false（弹框会成为看不见的模态，卡住应用）`,
    );
  }
  // 主窗口与插件窗口则是用户主动打开的界面，必须给用户「重试」的机会
  for (const file of ['src/main/window.ts', 'src/main/pluginWindows.ts']) {
    const source = read(file);
    const call = source.match(/attachLoadFailureRecovery\([\s\S]*?\);/);
    assert.ok(call, `${file} 未找到 attachLoadFailureRecovery 调用`);
    assert.ok(
      /promptUser:\s*true/.test(call[0]),
      `${file} 必须 promptUser: true —— 用户需要能重试，否则只能强杀应用`,
    );
  }
});
