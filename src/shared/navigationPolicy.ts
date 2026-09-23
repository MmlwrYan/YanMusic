/**
 * 顶层导航策略（IMP-12）。
 *
 * 背景：审计发现主进程没有任何 `will-navigate` 拦截——在 `webSecurity: false` 的前提下，
 * 渲染层一旦发生顶层导航（注入的链接、脚本改 `location`），应用会加载任意页面，
 * 而该页面仍持有 preload 暴露的全部能力。
 *
 * 关键事实（决定了本策略不会误伤应用自身）：
 *   - `webContents.loadURL()` / `loadFile()` **不会**触发 `will-navigate`
 *     （该事件只在页面自身发起导航时触发），因此窗口创建期的加载不受影响；
 *   - SPA 路由切换走 history API，不产生导航事件；
 *   - 开发模式下页面内的相对导航需要放行 dev server 源。
 */

const ALLOWED_PROTOCOLS = new Set(['file:', 'about:']);

export interface TopLevelNavigationPolicy {
  /** 开发服务器源（如 `http://localhost:5173`）；生产环境传 null。 */
  devServerOrigin?: string | null;
}

/**
 * 是否允许该 URL 成为顶层导航目标。
 * 放行：`file:`、`about:`、以及 dev server 同源；其余一律拒绝（fail-closed）。
 */
export const isAllowedTopLevelNavigation = (
  url: unknown,
  policy: TopLevelNavigationPolicy = {},
): boolean => {
  if (typeof url !== 'string' || url.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;

  const devOrigin = typeof policy.devServerOrigin === 'string' ? policy.devServerOrigin.trim() : '';
  if (!devOrigin) return false;

  try {
    return parsed.origin === new URL(devOrigin).origin;
  } catch {
    return false;
  }
};
