import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITEE_ARCHIVE_UA_HINT,
  PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT,
  applyPluginSourceProxy,
  isProviderHostedUrl,
  isSafeRepositoryFilePath,
  isZipArchiveBuffer,
  normalizeRepositoryFilePath,
  parsePluginRepository,
  resolvePluginDownloadUserAgent,
  toRepositoryArchiveUrl,
  toRepositoryBlobUrl,
  toRepositoryKey,
  toRepositoryRawFileUrl,
  toRepositorySourceId,
  toRepositoryUrl,
} from '../src/shared/plugin-source.ts';

/**
 * 单元测试：插件源「提供方」抽象（GitHub / Gitee）。
 *
 * ## 为什么把这块抽到 `shared/` 再测
 *
 * v1.4.0 之前，插件索引、清单、图标、插件包的地址**全部由 `src/main/plugins.ts` 自己拼 GitHub 专有 URL**
 * （`raw.githubusercontent.com`、`/archive/HEAD.zip`）。引入 Gitee 后，任何一处漏改都会拼出一个
 * **语法合法但指向 GitHub 的 Gitee 地址** —— 报错只会是 404，看不出根因。
 *
 * 抽成纯函数之后，这些 URL 形态可以在 `node --test` 下**直接驱动真行为**，
 * 而不是靠「源码里有没有那个字符串」的文本断言。
 *
 * ## 本文件锁定的三类事实（全部为实测，不是推测）
 *
 * 1. **地址形态**：Gitee 的归档端点是 `/repository/archive/<ref>.zip`，
 *    与 GitHub 的 `/archive/<ref>.zip` **不同**（用错就 404）；raw 端点 Gitee 走站内 `/raw/<ref>/<path>`。
 * 2. **加速器闸门**：现有加速器是 `gh-proxy` 一类，**只能反代 GitHub**。
 *    Gitee 地址一旦被套上加速器会直接打不开，因此必须被闸门挡住。
 * 3. **下载 UA**：Gitee 的归档端点在 UA 不被识别为下载工具时
 *    **返回 200 + text/html（落地页）而不是 zip** —— 实测两个仓库复现一致。
 *    这正是 `isZipArchiveBuffer` 要兜住的场景。
 */

// ── 仓库解析 ────────────────────────────────────────────────────────────────

test('parsePluginRepository：识别 GitHub / Gitee，且带出提供方', () => {
  assert.deepEqual(parsePluginRepository('https://github.com/MmlwrYan/YanMusicPlugins'), {
    provider: 'github',
    owner: 'MmlwrYan',
    repo: 'YanMusicPlugins',
  });
  assert.deepEqual(parsePluginRepository('https://gitee.com/mmlwryan/yanmusicplugins'), {
    provider: 'gitee',
    owner: 'mmlwryan',
    repo: 'yanmusicplugins',
  });
});

test('parsePluginRepository：`owner/repo` 简写按 GitHub 解释（向后兼容）', () => {
  assert.deepEqual(parsePluginRepository('hoowhoami/EchoMusicPlugins'), {
    provider: 'github',
    owner: 'hoowhoami',
    repo: 'EchoMusicPlugins',
  });
});

test('parsePluginRepository：`.git` 后缀与无 scheme 写法', () => {
  assert.equal(parsePluginRepository('https://github.com/a/b.git')?.repo, 'b');
  assert.equal(parsePluginRepository('gitee.com/a/b')?.provider, 'gitee');
});

test('parsePluginRepository：拒绝伪装域名（子串匹配会在这里出错）', () => {
  // `endswith('github.com')` 这类写法会把前两个放进来；必须带前导点做后缀匹配。
  assert.equal(parsePluginRepository('https://mygithub.com/a/b'), null);
  assert.equal(parsePluginRepository('https://notgithub.com/a/b'), null);
  // 真的子域必须放行（GitHub 的 raw/codeload 都是子域）。
  assert.equal(parsePluginRepository('https://raw.githubusercontent.com/a/b')?.provider, 'github');
  assert.equal(parsePluginRepository('https://codeload.github.com/a/b')?.provider, 'github');
  // 把 gitee.com 当作别人的子域：不是 gitee。
  assert.equal(parsePluginRepository('https://gitee.com.evil.example/a/b'), null);
});

test('parsePluginRepository：空值与非仓库地址返回 null', () => {
  assert.equal(parsePluginRepository(''), null);
  assert.equal(parsePluginRepository(null), null);
  assert.equal(parsePluginRepository('https://example.com/a/b'), null);
  assert.equal(parsePluginRepository('https://github.com/onlyowner'), null);
});

// ── 地址形态 ────────────────────────────────────────────────────────────────

test('仓库地址与源 ID 按提供方生成', () => {
  const gh = parsePluginRepository('github.com/A/B')!;
  const ge = parsePluginRepository('gitee.com/A/B')!;
  assert.equal(toRepositoryUrl(gh), 'https://github.com/A/B');
  assert.equal(toRepositoryUrl(ge), 'https://gitee.com/A/B');
  // 源 ID 一律小写：它是持久化在 KV 里的去重键，大小写不同会造成「同一个源出现两次」。
  assert.equal(toRepositorySourceId(gh), 'github:a/b');
  assert.equal(toRepositorySourceId(ge), 'gitee:a/b');
});

test('raw 文件地址：Gitee 与 GitHub 形态不同（Gitee 无独立 raw 域名）', () => {
  assert.equal(
    toRepositoryRawFileUrl(
      parsePluginRepository('github.com/MmlwrYan/YanMusicPlugins')!,
      'echo-plugins.json',
    ),
    'https://raw.githubusercontent.com/MmlwrYan/YanMusicPlugins/HEAD/echo-plugins.json',
  );
  assert.equal(
    toRepositoryRawFileUrl(
      parsePluginRepository('gitee.com/mmlwryan/yanmusicplugins')!,
      'echo-plugins.json',
    ),
    'https://gitee.com/mmlwryan/yanmusicplugins/raw/HEAD/echo-plugins.json',
  );
});

test('raw 文件地址：路径先规范化（去首尾斜杠 / 反斜杠 / `.`）', () => {
  const repo = parsePluginRepository('gitee.com/a/b')!;
  assert.equal(
    toRepositoryRawFileUrl(repo, '/third-party/owner/repo/manifest.json'),
    'https://gitee.com/a/b/raw/HEAD/third-party/owner/repo/manifest.json',
  );
  assert.equal(
    toRepositoryRawFileUrl(repo, 'third-party\\owner\\.\\repo\\manifest.json'),
    'https://gitee.com/a/b/raw/HEAD/third-party/owner/repo/manifest.json',
  );
});

test('归档地址：Gitee 是 /repository/archive/<ref>.zip，不是 /archive/<ref>.zip', () => {
  // ⚠️ 这条是「拼错就 404 且看不出为什么」的典型。实测（2026-10-03）：
  //    只有 /repository/archive/ 这个形态能拿到 zip。
  assert.equal(
    toRepositoryArchiveUrl(parsePluginRepository('gitee.com/a/b')!),
    'https://gitee.com/a/b/repository/archive/HEAD.zip',
  );
  assert.equal(
    toRepositoryArchiveUrl(parsePluginRepository('github.com/a/b')!),
    'https://github.com/a/b/archive/HEAD.zip',
  );
});

test('blob 地址（用于界面展示与 homepage 记录）', () => {
  assert.equal(
    toRepositoryBlobUrl(parsePluginRepository('gitee.com/a/b')!, 'echo-plugins.json'),
    'https://gitee.com/a/b/blob/HEAD/echo-plugins.json',
  );
});

// ── 去重键 ──────────────────────────────────────────────────────────────────

test('toRepositoryKey：可解析时用源 ID，不可解析时回落小写原串', () => {
  assert.equal(toRepositoryKey('https://github.com/A/B'), 'github:a/b');
  assert.equal(toRepositoryKey('https://gitee.com/A/B'), 'gitee:a/b');
  // 同一个仓库经不同提供方访问**必须**是不同的键，否则缓存会串。
  assert.notEqual(
    toRepositoryKey('https://github.com/a/b'),
    toRepositoryKey('https://gitee.com/a/b'),
  );
  // `owner/repo` 简写会被解析成 GitHub 源，因此**不带**回落语义。
  assert.equal(toRepositoryKey('  Whatever/Thing  '), 'github:whatever/thing');
  // 解析不了才回落：小写化 + 去首尾空白。
  assert.equal(toRepositoryKey('  Not A Repo  '), 'not a repo');
  assert.equal(toRepositoryKey(''), '');
});

// ── 加速器闸门 ──────────────────────────────────────────────────────────────

test('加速器闸门：GitHub 走加速器，Gitee 不套', () => {
  const proxy = 'https://gh-proxy.example/';
  assert.equal(
    applyPluginSourceProxy('https://raw.githubusercontent.com/a/b/HEAD/x.json', proxy),
    'https://gh-proxy.example/https://raw.githubusercontent.com/a/b/HEAD/x.json',
  );
  assert.equal(
    applyPluginSourceProxy('https://gitee.com/a/b/raw/HEAD/x.json', proxy),
    'https://gitee.com/a/b/raw/HEAD/x.json',
    'Gitee 必须原样返回：gh-proxy 一类加速器不能反代 Gitee，套上会直接打不开',
  );
});

test('加速器闸门：未配置加速器、或地址非 http(s) 时原样返回', () => {
  const gh = 'https://raw.githubusercontent.com/a/b/HEAD/x.json';
  assert.equal(applyPluginSourceProxy(gh, ''), gh);
  assert.equal(applyPluginSourceProxy(gh, undefined), gh);
  assert.equal(
    applyPluginSourceProxy('data:application/json,{}', 'https://p.example'),
    'data:application/json,{}',
  );
});

test('加速器闸门：加速器地址尾部斜杠被规范化（避免拼出双斜杠）', () => {
  assert.equal(
    applyPluginSourceProxy('https://github.com/a/b', 'https://p.example///'),
    'https://p.example/https://github.com/a/b',
  );
});

test('isProviderHostedUrl：带前导点后缀匹配，且区分提供方', () => {
  assert.equal(isProviderHostedUrl('https://github.com/a/b', 'github'), true);
  assert.equal(isProviderHostedUrl('https://raw.githubusercontent.com/a/b', 'github'), true);
  assert.equal(isProviderHostedUrl('https://gitee.com/a/b', 'github'), false);
  assert.equal(isProviderHostedUrl('https://gitee.com/a/b', 'gitee'), true);
  assert.equal(isProviderHostedUrl('https://mygithub.com/a/b', 'github'), false);
  assert.equal(isProviderHostedUrl('not a url', 'github'), false);
});

// ── 下载 UA ────────────────────────────────────────────────────────────────

test('下载 UA：Gitee 需要额外片段，GitHub 保持原样', () => {
  const ghUa = resolvePluginDownloadUserAgent('https://github.com/a/b/archive/HEAD.zip');
  const geUa = resolvePluginDownloadUserAgent('https://gitee.com/a/b/repository/archive/HEAD.zip');
  assert.equal(ghUa, PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT);
  assert.ok(geUa.startsWith(PLUGIN_MARKETPLACE_DOWNLOAD_USER_AGENT), '不能丢掉自己的标识');
  assert.ok(geUa.includes(GITEE_ARCHIVE_UA_HINT), 'Gitee 归档端点要求 UA 含该片段');
  assert.notEqual(ghUa, geUa);
});

// ── ZIP 校验（兜住「200 但不是压缩包」）────────────────────────────────────

test('isZipArchiveBuffer：接受三种 ZIP 魔数，拒绝 HTML', () => {
  assert.equal(isZipArchiveBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), true);
  assert.equal(isZipArchiveBuffer(Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00])), true);
  assert.equal(isZipArchiveBuffer(Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x00, 0x00])), true);
  // Gitee 在 UA 不合规时返回的正是 HTML（实测 200 + text/html + 45 KB）
  assert.equal(isZipArchiveBuffer(Buffer.from('<!DOCTYPE html><html>', 'utf8')), false);
  // ⚠️ 这条是**必要的**：只查前两字节 'PK' 时，上面那例会被 'P'≠'<' 挡住而通过，
  //    于是「第三/四字节签名」这段逻辑就永远测不到（变异成 `return true` 也不变红）。
  //    这条用例专门喂「以 PK 开头但不是 zip」的输入，用来锁定签名判定。
  assert.equal(isZipArchiveBuffer(Buffer.from('PKxxxx', 'utf8')), false, '仅前两字节匹配不算 zip');
  assert.equal(
    isZipArchiveBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x05])),
    false,
    '签名不匹配不算 zip',
  );
  assert.equal(isZipArchiveBuffer(Buffer.from('PK', 'utf8')), false, '长度不足 4 不能当作 zip');
  assert.equal(isZipArchiveBuffer(Buffer.alloc(0)), false);
});

// ── 路径规范化和安全判定 ───────────────────────────────────────────────────

test('normalizeRepositoryFilePath：规范化', () => {
  assert.equal(normalizeRepositoryFilePath('  a/b/c  '), 'a/b/c');
  assert.equal(normalizeRepositoryFilePath('a//b/./c'), 'a/b/c');
  assert.equal(normalizeRepositoryFilePath('\\a\\b\\'), 'a/b');
  assert.equal(normalizeRepositoryFilePath(''), '');
});

test('isSafeRepositoryFilePath：挡住目录穿越与绝对路径', () => {
  // 这条判定同时服务于「URL 拼装」和「解压时的穿越防护」——
  // 两处一旦口径不一致就是安全缺口，所以必须由同一个纯函数提供。
  assert.equal(isSafeRepositoryFilePath(''), true);
  assert.equal(isSafeRepositoryFilePath('third-party/owner/repo'), true);
  assert.equal(isSafeRepositoryFilePath('..'), false);
  assert.equal(isSafeRepositoryFilePath('a/../../b'), false);
  assert.equal(isSafeRepositoryFilePath('/etc/passwd'), false);
  assert.equal(isSafeRepositoryFilePath('C:\\Windows'), false);
  assert.equal(isSafeRepositoryFilePath('.'), false);
});
