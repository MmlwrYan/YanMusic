import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLOCKED_SQL_KEYWORDS,
  findBlockedSqlKeyword,
  normalizeSqlForInspection,
  stripSqlLiteralsAndComments,
} from '../src/shared/pluginSqlSafety.ts';

/**
 * M-6 回归守卫（v1.2.4）：插件 SQL 危险语句拦截必须顶住「注释/空白分隔」绕过。
 *
 * 复现（修复前）：黑名单用 `\s` 匹配关键字之间的空白，而 SQLite 允许注释充当
 * 词间分隔符 → 把 VACUUM 与 INTO 用块注释隔开即可漏过黑名单，但 SQLite 照常
 * 解析执行 → 任意路径写出（黑名单绕过 → 任意文件写）。
 *
 * 修复后：先做词法归一化（剥注释/字面量 → 小写 → 压缩空白）再判关键字，
 * 任何拆法都会还原为 `vacuum into` 而被拦下。
 *
 * 直接测 `src/shared/pluginSqlSafety.ts`（纯函数、无 electron 依赖），
 * 因此可在 `node --test` 下稳定运行。
 */

// 用拼接避免本文件自己出现可被误判的字面量
const OPEN_COMMENT = '/' + '*';
const CLOSE_COMMENT = '*' + '/';

test('M-6：VACUUM INTO 的注释/空白绕过写法一律被拦下', () => {
  const payloads = [
    "VACUUM/**/INTO 'C:/any/path.sqlite'",
    "VACUUM /* c */ INTO 'C:/any/path.sqlite'",
    "VACUUM--\nINTO 'C:/any/path.sqlite'",
    "VACUUM\nINTO 'C:/any/path.sqlite'",
    "vacuum\tinto 'C:/any/path.sqlite'",
    'VACUUM     INTO x',
    'VaCuUm/*a*/InTo(x)',
    `VACUUM${OPEN_COMMENT}${CLOSE_COMMENT}INTO x`,
    'VACUUM\r\nINTO x',
    'VACUUM/**//**/INTO x',
  ];
  for (const sql of payloads) {
    assert.equal(
      findBlockedSqlKeyword(sql),
      'vacuum',
      `未拦下：${JSON.stringify(sql)}`,
    );
  }
});

test('M-6：ATTACH / DETACH / load_extension / PRAGMA 的绕过写法一律被拦下', () => {
  const cases: Array<[string, string]> = [
    ["ATTACH/**/DATABASE 'x' AS y", 'attach'],
    ['DETACH/**/DATABASE y', 'detach'],
    ['attach database x as y', 'attach'],
    ["SELECT/**/load_extension('evil.so')", 'load_extension'],
    ['PRAGMA/**/database_list', 'pragma'],
    ['PRAGMA user_version', 'pragma'],
  ];
  for (const [sql, expected] of cases) {
    assert.equal(findBlockedSqlKeyword(sql), expected, `未拦下：${JSON.stringify(sql)}`);
  }
});

test('M-6：整条关键字列表都在生效（防有人删条目）', () => {
  for (const keyword of BLOCKED_SQL_KEYWORDS) {
    assert.equal(
      findBlockedSqlKeyword(`SELECT 1; ${keyword.toUpperCase()} x`),
      keyword,
      `关键字 ${keyword} 未被拦截`,
    );
  }
  // 确认列表未被削减到只剩一两个
  assert.ok(BLOCKED_SQL_KEYWORDS.length >= 5, `被禁关键字只剩 ${BLOCKED_SQL_KEYWORDS.length} 个`);
});

test('M-6：关键字出现在字符串字面量/注释里时不得误报', () => {
  const allowed = [
    "SELECT 'VACUUM INTO x' AS note",
    'SELECT "attach" AS word',
    'SELECT 1 -- 这里写 VACUUM INTO 只是注释',
    'SELECT 1 /* PRAGMA database_list */',
    "INSERT INTO t (v) VALUES ('load_extension(')",
    'SELECT `attach` FROM t',
    'SELECT [detach] FROM t',
  ];
  for (const sql of allowed) {
    assert.equal(findBlockedSqlKeyword(sql), null, `误报：${JSON.stringify(sql)}`);
  }
});

test('M-6：普通增删改查与在建表语句不得被误拦', () => {
  const normal = [
    'SELECT * FROM songs WHERE id = ?',
    'INSERT INTO songs (id, name) VALUES (?, ?)',
    'UPDATE songs SET name = ? WHERE id = ?',
    'DELETE FROM songs WHERE id = ?',
    'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)',
    'CREATE TABLE vacuum_log (id INTEGER)',
    'BEGIN; UPDATE t SET a = 1; COMMIT;',
    'DROP TABLE IF EXISTS t',
    'CREATE INDEX idx ON t (a)',
  ];
  for (const sql of normal) {
    assert.equal(findBlockedSqlKeyword(sql), null, `正常 SQL 被误拦：${JSON.stringify(sql)}`);
  }
});

test('M-6：词法预处理的自检（剥注释与字面量确实生效）', () => {
  // 注释被替换为空白，关键字不再相邻
  const stripped = stripSqlLiteralsAndComments('a/* x */b');
  assert.ok(!stripped.includes('x'), '块注释内容未被剥除');
  assert.ok(!stripped.includes('/*'), '块注释标记未被剥除');

  assert.equal(normalizeSqlForInspection('VACUUM/*a*/INTO'), 'vacuum into');
  assert.equal(normalizeSqlForInspection("SELECT 'a b'"), 'select');

  // 未闭合的块注释不应导致死循环（消费到结尾即可）
  assert.doesNotThrow(() => stripSqlLiteralsAndComments('SELECT 1 /* 未闭合'));
  assert.doesNotThrow(() => stripSqlLiteralsAndComments("SELECT '未闭合"));
});
