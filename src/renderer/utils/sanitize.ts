import DOMPurify from 'dompurify';

/**
 * 外链必须带 `rel="noopener noreferrer"`（W-4）。
 *
 * 背景：`ALLOWED_ATTR` 放行了 `target`，而 `target="_blank"` 会让新页面拿到
 * `window.opener` 句柄（反向操纵本页）。DOMPurify 默认**不会**自动补 `rel`，
 * 因此这里挂一个 `afterSanitizeAttributes` 钩子统一补上。
 *
 * 注：本项目渲染层已有 `setWindowOpenHandler`（仅放行 `https:` 且一律 `deny`）兜底，
 * 本钩子属**纵深防御**，不改变现有行为，只是让「经过 sanitize 的外链」自身就是安全的。
 *
 * 钩子挂在 DOMPurify 全局实例上，用模块级 flag 保证只注册一次
 * （ESM 模块只求值一次，但 HMR / 重复加载下累积注册会导致重复设置属性）。
 */
let noopenerHookInstalled = false;

const ensureNoopenerHook = (): void => {
  if (noopenerHookInstalled) return;
  noopenerHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    const anchor = node as unknown as Element;
    if (anchor.hasAttribute('target')) anchor.setAttribute('rel', 'noopener noreferrer');
  });
};

export const sanitizeHtml = (html: string): string => {
  ensureNoopenerHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'ul',
      'ol',
      'li',
      'a',
      'code',
      'pre',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
};
