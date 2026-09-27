import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isPathInsideRoot, normalizePath } from '../src/shared/pathBoundary.ts';

/**
 * M-5 回归守卫（v1.2.4）：路径边界判定必须**在目录边界处**比较。
 *
 * 背景：原生 `plugin_sqlite_open` 不校验路径，防护全在 JS 层。这里为 JS 层的
 * 边界断言提供纯函数实现并加固其正确性 —— 特别要防止 `/root-other` 因以
 * `/root` 为前缀而被误判为「在根内」。
 */

const ROOT = 'C:/Users/u/AppData/Roaming/YanMusic/plugin-sqlite/com.example.plugin';

test('M-5：根目录自身的路径判定为「在内」', () => {
  assert.equal(isPathInsideRoot(ROOT, ROOT), true);
  assert.equal(isPathInsideRoot(ROOT, ROOT + '/'), true);
  assert.equal(isPathInsideRoot(ROOT + '/', ROOT), true);
});

test('M-5：根目录内的常规路径判定为「在内」', () => {
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/main.sqlite`), true);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/sub/dir/data.sqlite`), true);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/main.sqlite-wal`), true);
});

test('M-5：前缀相似但不同目录必须判为「在外」（目录边界比较）', () => {
  // 关键用例：不能因为 startsWith(root) 就放行
  assert.equal(isPathInsideRoot(ROOT, ROOT + '-other/main.sqlite'), false);
  assert.equal(isPathInsideRoot(ROOT, ROOT + 'evil/main.sqlite'), false);
  assert.equal(isPathInsideRoot('/a/b', '/a/bc/d'), false);
  assert.equal(isPathInsideRoot('/a/b', '/a/bc'), false);
});

test('M-5：父目录与无关绝对路径判为「在外」', () => {
  assert.equal(isPathInsideRoot(ROOT, 'C:/Users/u/AppData/Roaming/YanMusic'), false);
  assert.equal(isPathInsideRoot(ROOT, 'C:/Windows/System32/config/SAM'), false);
  assert.equal(isPathInsideRoot(ROOT, '/etc/passwd'), false);
  assert.equal(isPathInsideRoot(ROOT, 'C:/'), false);
  assert.equal(isPathInsideRoot(ROOT, ''), false);
});

test('M-5：`..` 穿越必须被折叠后判为「在外」', () => {
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/../other/main.sqlite`), false);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/../../../../etc/passwd`), false);
  // ROOT/sub/.. 折叠后回到 ROOT 本身 → 在内
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/sub/..`), true);
  // ROOT/sub/../main.sqlite 折叠后即 ROOT/main.sqlite → 在内
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/sub/../main.sqlite`), true);
  // 再上一级就出了根
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/sub/../..`), false);
  // 通配成根目录自身
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}/a/..`), true);
});

test('M-5：反斜杠分隔与重复分隔符应被规范化（Windows 路径）', () => {
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}\\main.sqlite`), true);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}//main.sqlite`), true);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}\\.\\main.sqlite`), true);
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}\\..\\other`), false);
});

test('M-5：大小写不敏感（Windows/macOS 默认文件系统）', () => {
  assert.equal(isPathInsideRoot(ROOT, ROOT.toUpperCase() + '/main.sqlite'), true);
  assert.equal(isPathInsideRoot(ROOT, ROOT.toLowerCase() + '/main.sqlite'), true);
  // 显式要求区分大小写时应如实区分
  assert.equal(
    isPathInsideRoot(ROOT, ROOT.toUpperCase() + '/main.sqlite', { caseInsensitive: false }),
    false,
  );
});

test('M-5：normalizePath 的基本性质', () => {
  assert.equal(normalizePath('C:/a//b/./c/../d'), 'c:/a/b/d');
  assert.equal(normalizePath('C:\\a\\b'), 'c:/a/b');
  assert.equal(normalizePath('/a/b/'), '/a/b');
  assert.equal(normalizePath('   '), '');
  // 折叠到根以上时应停止在根
  assert.equal(normalizePath('/a/../../b'), '/b');
});

test('M-5：主进程侧确实接入了边界断言（防有人删掉）', () => {
  // 直接读源码确认接线还在（该文件依赖 electron，无法在测试进程导入）
  const source = readFileSync(path.resolve(process.cwd(), 'src/main/pluginSqlite.ts'), 'utf8');
  assert.ok(
    /assertDatabasePathInsideRoot/.test(source),
    'pluginSqlite.ts 缺少 assertDatabasePathInsideRoot',
  );
  assert.ok(
    /isPathInsideRoot\(/.test(source),
    'pluginSqlite.ts 未调用 isPathInsideRoot —— 边界断言可能已退化为字符串前缀比较',
  );
  assert.ok(
    /realpathSync\(/.test(source),
    'pluginSqlite.ts 缺少 realpath 复核 —— 符号链接可跳出插件目录',
  );
});

/**
 * L-4 守卫（v1.2.4）：库名不得包含 `..`。
 * 原正则允许点号但未禁止连续点；虽因「首字符必须是字母数字」尚未构造出确定的
 * 越界输入，仍应收紧，使 `join(root, name + '.sqlite')` 结构上不可能跳出根目录。
 */
test('L-4：normalizeDatabaseName 必须显式拒绝含 ".." 的库名', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'src/main/pluginSqlite.ts'), 'utf8');
  const start = source.indexOf('const normalizeDatabaseName');
  assert.ok(start >= 0, '未找到 normalizeDatabaseName');
  const body = source.slice(start, source.indexOf('const getPluginSqliteRoot'));

  assert.ok(
    /includes\(\s*'\.\.'\s*\)/.test(body),
    'normalizeDatabaseName 未显式拒绝 ".." —— L-4 的加固可能被回退',
  );
  assert.ok(/throw new Error/.test(body), '拒绝 ".." 后必须抛错，而不是静默修正');
});
