/**
 * 插件展示文案的品牌替换（纯函数，可在 node 下直接单测）。
 *
 * 背景：上游插件的清单里，`description` 与 `author` 等**面向用户展示**的字段写着
 * `EchoMusic`，例如「使用 @applemusic-like-lyrics/core 渲染 **EchoMusic** 页面歌词。」
 * 本项目是 EchoMusic 的二次开发，这些描述在界面上显示时应当读作 `YanMusic`。
 *
 * ## 只动「展示文案」，不动标识与校验类字段
 *
 * 这里处理插件简介、描述、**作者展示名**这类会直接渲染给用户的文本：
 * - **不改** 仓库地址、`repo` / `homepage` / `downloadUrl` / `checksum` 等
 *   **标识与校验类**字段 —— `github.com/hoowhoami/EchoMusicPlugins` 是真实存在的地址，
 *   改了就打不开；
 * - **不改** 分享链接里携带的值 —— 它要在不同客户端之间往返解析，改了会变成另一个插件；
 * - **不改** 许可与致谢文案（`constants/legal.ts`）—— 那里写 `EchoMusic` 是**如实**的版权声明。
 *
 * ## 关于 `author`（v1.3.5 订正）
 *
 * v1.3.4 曾把 `author` 列为「不动的字段」，理由是「那是作者署名，换掉等于篡改归属」。
 * **该前提经实测推翻**：真实清单 14 个条目里，`author` 为 `EchoMusic` 的有 **10 个**
 * —— 那是**上游项目名**被填进了作者位，不是真人署名；另有 `吴彦祖` / `Codex Sol` / `小栀`
 * 三个真人昵称。故现对 `author` 同样施加替换：完整单词 `EchoMusic` 被换掉，
 * 真人昵称天然不受影响（**完整单词匹配**的边界规则见下）。
 *
 * ## 匹配规则
 *
 * 只替换**完整单词**形式（大小写不敏感），且大小写以「全大写 `ECHOMUSIC`→全大写」、
 * 「其余 → `YanMusic`」的规则收敛，避免把 `EchoMusic` 在句首/句中改出两种写法。
 * 不做模糊/子串替换：`EchoMusicPlugins` 这类**标识符**不应被改成 `YanMusicPlugins`
 * ——那是别人的仓库名。
 *
 * ## ⚠️ 生效点必须在「输出边界」，不是「数据入口」
 *
 * v1.3.4 把替换做在 `normalizeMarketplaceIndexPlugin`（联网拉取时的索引归一化），
 * 而插件市场列表**默认走本地缓存回放**（`hydrateMarketplacePlugins` 直吃缓存，不过归一化）
 * —— 于是存量用户的界面照旧显示 `EchoMusic`。现将替换下沉到 `hydrateMarketplacePlugins`
 * 的返回处（网络与缓存两条路径在此汇合）。**新增展示字段时，请确认它经过输出边界。**
 */

/** 仅匹配独立的 `EchoMusic` 单词（前后不能紧邻字母/数字/连字符/下划线）。 */
const ECHO_MUSIC_WORD_PATTERN = /(?<![A-Za-z0-9_-])echomusic(?![A-Za-z0-9_-])/gi;

/** 展示文案的品牌词，取值与项目名一致。 */
export const PLUGIN_BRANDING_NAME = 'YanMusic';

/**
 * 把展示文案里的 `EchoMusic` 品牌词替换为 `YanMusic`。
 *
 * 输入非字符串（`undefined` / `null` / 数字等）一律按空串处理，返回空串。
 */
export const replaceEchoMusicBranding = (value: unknown): string => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text) return '';
  return text.replace(ECHO_MUSIC_WORD_PATTERN, (matched) =>
    matched === matched.toUpperCase() ? PLUGIN_BRANDING_NAME.toUpperCase() : PLUGIN_BRANDING_NAME,
  );
};
