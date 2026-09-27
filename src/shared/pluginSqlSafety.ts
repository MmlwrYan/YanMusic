/**
 * 插件 SQL 语句检查（纯函数，无 Electron / 原生依赖）。
 *
 * 抽到 shared 层的原因有二：
 *   1. 让 `validateSql` 可以在 `node --test` 下直接单测（主进程模块依赖 electron，
 *      在测试进程里无法导入）；
 *   2. 明确它是一段**可独立验证的安全逻辑**，而不是埋在业务文件里的实现细节。
 *
 * 背景（审计发现 M-6，v1.2.4）：
 *   修复前的黑名单 `/\b(?:ATTACH|DETACH)\b|\bVACUUM\s+INTO\b|…/i` 用 `\s` 匹配
 *   关键字间的空白，但 SQLite 允许**注释**充当词间分隔符。把 `VACUUM` 与 `INTO`
 *   用块注释隔开即可漏过黑名单，而 SQLite 照常解析执行 → 可把数据库副本写到
 *   进程有权限的任意路径（黑名单绕过 → 任意文件写，CWE-78 / CWE-94 类）。
 *
 * 修复思路：**先做词法归一化，再判关键字**。
 *   1. 剥掉所有注释（行注释、块注释）与字符串/标识符字面量；
 *   2. 转小写，把非字母数字下划线的字符一律压成单空格；
 *   3. 对归一化结果做「独立词」匹配。
 * 于是无论攻击者怎么拆（注释、换行、制表符、大小写），都会还原成
 * `vacuum into` 而被拦下；而出现在字面量里的同名词不会被误报。
 *
 * 局限（如实声明）：这仍是**文本层黑名单**的加强版，不是真正的 SQL 语法分析器。
 *   它能可靠堵住「注释/空白分隔」这一类绕过（已实测），但无法穷尽所有 SQLite
 *   语法等价形式。彻底的方案是在原生层用 `sqlite3_set_authorizer` 做白名单授权，
 *   已记入报告 M-6 的后续事项。
 */

/** 插件 SQL 中禁止出现的独立关键字 */
export const BLOCKED_SQL_KEYWORDS = [
  'attach',
  'detach',
  'vacuum',
  'load_extension',
  'pragma',
] as const;

/**
 * 去掉字符串字面量、标识符引号与注释，返回只保留结构性字符的文本。
 * 注释与字面量的内容一律替换为单个空格，避免把相邻词粘连。
 */
export const stripSqlLiteralsAndComments = (sql: string): string => {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // 行注释：-- 到行尾
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    // 块注释：成对星号（SQLite 不支持嵌套）
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }

    // 单引号字符串：连写两个为转义
    if (ch === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // 双引号 / 反引号标识符
    if (ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    // 方括号标识符
    if (ch === '[') {
      i += 1;
      while (i < n && sql[i] !== ']') i += 1;
      i = Math.min(i + 1, n);
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
};

/**
 * 归一化：剥注释/字面量 → 转小写 → 非字母数字下划线压成单空格 → 去首尾空白。
 * 结果里每个关键字都以「空格 + 词 + 空格」的形式出现，便于做独立词匹配。
 */
export const normalizeSqlForInspection = (sql: string): string =>
  stripSqlLiteralsAndComments(sql)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim();

/** 检查结果：命中则返回被禁关键字，否则返回 null */
export const findBlockedSqlKeyword = (sql: string): string | null => {
  const normalized = ` ${normalizeSqlForInspection(sql)} `;
  for (const keyword of BLOCKED_SQL_KEYWORDS) {
    if (normalized.includes(` ${keyword} `)) return keyword;
  }
  return null;
};
