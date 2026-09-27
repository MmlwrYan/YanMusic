/**
 * 插件文件/数据库路径的**边界判定**（纯函数，无 electron / 原生依赖）。
 *
 * 抽到 shared 层的原因同 `pluginSqlSafety.ts`：主进程模块依赖 electron，
 * 在 `node --test` 进程里无法导入；而这段逻辑是可独立验证的安全边界。
 *
 * 背景（审计发现 M-5，v1.2.4）：
 *   原生 `plugin_sqlite_open` 接受任意 `database_path` 且不校验，越权防护全在 JS 层。
 *   本模块提供 `normalizePath` / `isPathInsideRoot`，让 JS 边界能做**显式断言**。
 */

/**
 * 规范化路径：统一分隔符、折叠 `.`/`..`、去掉多余与尾部斜杠。
 * 可选按平台折叠大小写（Windows / macOS 默认文件系统不区分大小写）。
 *
 * 只做**字符串层面**处理，不访问文件系统。
 */
export const normalizePath = (input: string, caseInsensitive = true): string => {
  const value = String(input ?? '').trim().replace(/\\/g, '/');
  if (!value) return '';

  // 记录前缀（POSIX 根 / Windows 盘符）；盘符要从分段里剔除，避免重复拼接
  const driveMatch = /^([a-zA-Z]):/.exec(value);
  const drive = driveMatch ? driveMatch[1].toLowerCase() : '';
  const isAbsolute = value.startsWith('/');
  const body = drive ? value.slice(driveMatch![0].length) : value;

  const segments: string[] = [];
  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  let normalized = segments.join('/');
  if (drive) normalized = `${drive}:/${normalized}`;
  else if (isAbsolute) normalized = `/${normalized}`;

  normalized = normalized.replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
};

/**
 * 判断 `target` 是否落在 `root` 之内（含 root 本身）。
 *
 * 关键在于**在目录边界处比较**：`/root-other` 绝不能因为以 `/root` 开头而被放行。
 * 因此比较时给 root 补一个尾部 `/`。
 */
export const isPathInsideRoot = (
  root: string,
  target: string,
  options: { caseInsensitive?: boolean } = {},
): boolean => {
  const caseInsensitive = options.caseInsensitive ?? true;
  const normalizedRoot = normalizePath(root, caseInsensitive);
  const normalizedTarget = normalizePath(target, caseInsensitive);
  if (!normalizedRoot || !normalizedTarget) return false;
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}/`);
};
