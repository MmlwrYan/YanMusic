/**
 * 插件 manifest 的 `capabilities` 白名单（零依赖纯函数，可在 node 下直接单测）。
 *
 * ## 为什么要单独一个模块
 *
 * 此前「已知 capability」这份名单**只以 if 序列的形式散落在
 * `src/main/plugins/descriptor.ts` 的 `validateManifestCapabilities()` 里**，
 * 后果有两个：
 *
 * 1. **没有任何地方能回答「这个键是本项目认识的吗」** —— 于是无法对未知键做任何事；
 * 2. 该函数 `import` 了 electron，**无法在 node 下驱动真行为**，只能靠源码正则断言。
 *
 * 抽成本模块后，判定逻辑变成可直接 `import` 的纯函数（与 `shared/kvEnvelope.ts`、
 * `main/plugins/senderIdentity.ts`、`shared/plugin-source.ts` 同一思路）。
 *
 * ## 为什么未知键「只告警、不拒绝」
 *
 * 上游 EchoMusic 会持续新增能力字段，本项目只是它的二次开发。
 * 若对未知键 fail-closed，**任何一个上游新字段都会让插件在本项目里装不上** ——
 * 这与 v1.3.3 修掉的「13/13 插件全被拦」是同一类事故。
 *
 * 但**静默放行也不行**，这正是运行时实测抓到的形态（见下）。所以本模块的立场是：
 * **未知键 = 明确告知，但不阻断**。
 *
 * ## 实测背景（2026-10-14，运行时验证）
 *
 * 官方源里的 `water-lyrics` 声明了 `capabilities.lyricsPage: true` ——
 * 而 `lyricsPage` **在本项目源码里 0 命中**。它对应的 API `ctx.ui.lyricsPage` 不存在，
 * 于是插件**装完、启用、然后运行时报 `TypeError`**，界面只显示「出错」两个字。
 *
 * 也就是说：**「声明了本项目不认识的能力」是一个有实际预测价值的信号** ——
 * 它往往意味着「这个插件需要上游更新的 API」。本模块把它显式化，供安装前提示使用。
 */

/**
 * 本项目**已知**的 capability 键。
 *
 * ⚠️ 新增 capability 时**必须同步往这里加**，否则该键会被判为「未知」并产生告警。
 * 反向的一致性由 `tests/plugin-capabilities.test.ts` 守卫：
 * 它会扫描 `descriptor.ts` 的校验序列，要求两边**完全一致**（既不漏也不多）。
 */
export const KNOWN_PLUGIN_CAPABILITIES: readonly string[] = [
  'audioSource',
  'audioSpectrum',
  'kugouApi',
  'kugouVerification',
  'localFiles',
  'lyricEffects',
  'lyrics',
  'process',
  'sqlite',
  'unrestrictedNetwork',
  'webServer',
];

const KNOWN_CAPABILITY_SET = new Set<string>(KNOWN_PLUGIN_CAPABILITIES);

/**
 * 取出 `capabilities` 里**本项目不认识**的键，按字典序排序返回。
 *
 * 非对象（数组 / null / 字符串 / undefined）一律返回空数组 —— 类型错误由
 * `validateManifestCapabilities()` 负责报错，本函数**只回答「哪些键陌生」**，
 * 不重复承担校验职责（避免出现两处判定口径）。
 */
export const findUnknownCapabilityKeys = (capabilities: unknown): string[] => {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return [];
  }
  return Object.keys(capabilities as Record<string, unknown>)
    .filter((key) => !KNOWN_CAPABILITY_SET.has(key))
    .sort();
};

/** 该键是否为本项目已知的 capability。 */
export const isKnownPluginCapability = (key: string): boolean =>
  KNOWN_CAPABILITY_SET.has(String(key ?? ''));

/**
 * 未知 capability 的用户可读说明（用于日志与诊断包）。
 *
 * 措辞刻意**不断言「插件坏了」** —— 未知键只说明「本项目不认识它」，
 * 可能是上游新能力，也可能是拼写错误，两种情况都不该被说成确定性的故障。
 */
export const describeUnknownCapabilities = (keys: readonly string[]): string => {
  if (!keys.length) return '';
  return (
    `manifest.capabilities 含 ${keys.length} 个本程序不认识的键：${keys.join('、')}` +
    '（可能来自更新的上游版本，也可能是拼写错误；已放行，但相关功能可能不可用）'
  );
};
