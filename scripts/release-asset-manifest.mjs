/**
 * 发布产物**允许清单的唯一来源**（v1.4.2 / R-2 加固）。
 *
 * ## 为什么要有这个模块
 *
 * 原来的允许清单写死在 `scripts/check-release-artifacts.mjs` 里。
 * 但发布流程现在有**两道**校验，都需要同一份清单：
 *
 * 1. **上传前**：`check-release-artifacts.mjs` 校验 `release-artifacts/` 目录；
 * 2. **发布后**：`check-published-release-assets.mjs` 校验 **Release 上真实存在的附件**。
 *
 * 第 2 道是 v1.4.2 补的，原因是 **v1.4.2 自己又踩了一次 v1.4.0 的坑**：
 * 上传前的目录校验**报了「22 个吻合」**，而 Release 最终却有 **23 个附件**
 * （多出 `first-screen.png`）。也就是说：**目录快照通过 ≠ 发布结果正确。**
 *
 * ⇒ 与其让两份清单各自维护（必然漂移），不如**抽成一份共用定义**。
 * 「清单只有一处」这条约束，本身就是防止「两边自洽地一起错」的手段。
 *
 * ⚠️ 本模块**不得引入任何副作用**（不发网络请求、不读环境变量），
 * 这样两边都能安全 import。
 */

/** electron-builder 生成的自动更新元数据（逐个列出：少一个意味着某平台增量更新静默失效）。 */
export const EXPECTED_METADATA = [
  'latest.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'latest-mac.yml',
];

/**
 * 非元数据产物的后缀：真实产物名为 `YanMusic-<版本>-<后缀>`。
 * 清单来自 `build.yml` 各腿的 `artifact_glob`。
 */
export const EXPECTED_PAYLOAD_SUFFIXES = [
  // macOS
  'mac-arm64.zip',
  'mac-x64.zip',
  'macOS-arm64.dmg',
  'macOS-x64.dmg',
  // Windows
  'Windows-Setup-arm64.exe',
  'Windows-Setup-x64.exe',
  // Linux
  'linux-aarch64.pacman',
  'linux-aarch64.pkg.tar.zst',
  'linux-aarch64.rpm',
  'linux-amd64.deb',
  'linux-arm64.AppImage',
  'linux-arm64.deb',
  'linux-arm64.tar.gz',
  'linux-x64.pacman',
  'linux-x64.pkg.tar.zst',
  'linux-x64.tar.gz',
  'linux-x86_64.AppImage',
  'linux-x86_64.rpm',
];

/** 约定产物总数（18 平台产物 + 4 元数据）。 */
export const EXPECTED_TOTAL = EXPECTED_PAYLOAD_SUFFIXES.length + EXPECTED_METADATA.length;

/**
 * 把一组**真实文件名**与清单做双向比对。
 *
 * @param {string[]} actualNames 实际文件名（顺序无所谓）
 * @param {string} version 版本号（不带前导 v）
 * @returns {{ ok: boolean, missing: string[], unexpected: string[], expected: string[], actual: string[] }}
 */
export const compareAgainstManifest = (actualNames, version) => {
  const expected = [
    ...EXPECTED_PAYLOAD_SUFFIXES.map((s) => `YanMusic-${version}-${s}`),
    ...EXPECTED_METADATA,
  ].sort();

  const actual = [...actualNames].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    ok: expected.length === actual.length && expected.every((n) => actualSet.has(n)),
    expected,
    actual,
    missing: expected.filter((n) => !actualSet.has(n)),
    unexpected: actual.filter((n) => !expectedSet.has(n)),
  };
};
