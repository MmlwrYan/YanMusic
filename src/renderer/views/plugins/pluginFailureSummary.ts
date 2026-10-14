/**
 * 插件卡片上的**内联故障摘要**（V4-18，v1.4.0）。
 *
 * ## 为什么单独一个零依赖模块
 *
 * 这段逻辑原先只存在于 `InstalledPluginCard.vue` 的 `computed` 里，
 * 而 `.vue` 无法在 node 下直接驱动 → 只能靠源码正则断言，**那不是真行为测试**。
 * 按项目一贯做法（`shared/kvEnvelope.ts`、`shared/plugin-capabilities.ts`、
 * `main/plugins/senderIdentity.ts`），把纯逻辑抽出来即可直接单测。
 *
 * ## 背景（运行时实测，2026-10-14）
 *
 * `water-lyrics` 启用失败后，卡片上只有状态徽标「出错」/「异常」二字；
 * 完整错误（`TypeError: Cannot read properties of undefined (reading 'register')`
 * 与调用栈）其实**一直都有**，但要点开右侧一个不带文字的小三角图标才看得到。
 *
 * 实测结论（必须如实记载）：**详情弹窗早已存在且内容完整**，所以本项并不是
 * 「信息丢失」，而是「信息**不易发现**」。本模块只负责把摘要压成一行，
 * 完整信息仍由详情弹窗承载。
 */

/** 摘要的最大字符数；超出截断并加省略号。 */
export const FAILURE_SUMMARY_MAX_CHARS = 120;

/**
 * 把任意错误消息压成**单行摘要**。
 *
 * 规则：
 * - 换行 / 制表 / 连续空白 → 单个空格（错误消息常带多行堆栈，直接内联会撑破卡片）；
 * - 首尾去空白；
 * - 超过 {@link FAILURE_SUMMARY_MAX_CHARS} 字符则截断并补 `…`；
 * - 空 / 非字符串 / 全空白 → 返回空串（调用方据此不渲染该行）。
 *
 * **刻意不做「按像素截断」** —— 那需要测量 DOM 且要考虑字体，收益不抵复杂度；
 * CSS 侧另有 `-webkit-line-clamp: 1` 兜底。
 */
export const buildFailureSummary = (
  message: unknown,
  maxChars: number = FAILURE_SUMMARY_MAX_CHARS,
): string => {
  if (typeof message !== 'string') return '';
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (limit === 0 || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
};
