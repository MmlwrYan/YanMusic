import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNALLY_REGISTERED_CHANNELS, describeScopeTable } from '../src/main/ipc/permissions.ts';

/**
 * P-4a（v1.3.0）守卫：「在 `ipcRegistry` 之外直连注册」的 9 个通道
 * 必须**既并入规则表、又接入观测**。
 *
 * ## 背景
 *
 * 这 9 条（`audio-spectrum:*` / `media-control:*` / `thumbar:update-play-state`）此前
 * **既不在 `SCOPE_RULES` 内**（走 `DEFAULT_SCOPE`，等于没有显式判定依据），
 * 也**绕开观测**（直连 `ipcMain.handle` / `ipcMain.on`，不经 `ipcRegistry` 的
 * `observeIpcCall`）→ 调用完全不可见。v1.2.9 把该清单写进 `permissions.ts`
 * 作为「v1.3.0 的前置条件」（见 `ipc-permission-observation.test.ts` 的用例名）。
 *
 * 本版只做「**并入规则表 + 接入观测**」，**不开 `IPC_PERMISSION_STRICT`**（§6 已拍板）——
 * 观测只记录不拒绝，数据供下一版决定是否收窄 scope。
 *
 * ## 本文件锁的两件事
 *
 * 1. **显式并入**：9 条各自能被 `SCOPE_RULES` 的某条规则**显式命中**，且该规则填写了
 *    `basis`。仅靠 `DEFAULT_SCOPE` 兜底会返回同样的 `all`，故不能只看 `scopeForChannel`
 *    的返回值 —— 必须查**规则表本身**，否则「没并入」与「并入了 all」无法区分。
 * 2. **接入观测**：注册这 9 条的文件里，必须出现 `observeIpcCall`（显式观测包装）
 *    或 `registerHandler` / `registerListener`（走注册表即自动观测）。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① 删掉 `audioSpectrum.ts` 里 `handleObserved` 内的 `observeIpcCall(...)` 调用 → 用例 2 变红；
 *  ② 从 `SCOPE_RULES` 删掉 `media-control:` 规则 → 用例 1 变红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const collectMainSources = (): Array<{ rel: string; source: string }> => {
  const results: Array<{ rel: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (!statSync(full).isFile()) continue;
      results.push({
        rel: path.relative(repoRoot, full).replace(/\\/g, '/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(path.join(repoRoot, 'src', 'main'));
  return results;
};

test('P-4a：9 个直连注册通道必须被 SCOPE_RULES 显式命中（不能只靠 DEFAULT_SCOPE 兜底）', () => {
  const table = describeScopeTable();
  assert.ok(table.length > 0, '规则表为空 —— 守卫失效');

  const explicitPrefixes = table.map((rule) => rule.prefix);
  const hitByRule = (channel: string) =>
    explicitPrefixes.some((prefix) =>
      prefix.endsWith(':') ? channel.startsWith(prefix) : channel === prefix,
    );

  const uncovered = EXTERNALLY_REGISTERED_CHANNELS.filter((channel) => !hitByRule(channel));
  assert.deepEqual(
    uncovered,
    [],
    '以下直连注册的通道仍未被规则表显式覆盖（并入未生效）：' +
      '它们会走 DEFAULT_SCOPE，判定依据缺失，观测数据也无法归因',
  );

  // 规则表要求填写「判定依据」——空 basis 会让后来者无法理解为何是该 scope
  const emptyBasis = table.filter((rule) => !rule.basis || !String(rule.basis).trim());
  assert.deepEqual(
    emptyBasis.map((rule) => rule.prefix),
    [],
    '规则表中存在未填写 basis 的条目',
  );
});

test('P-4a：9 个直连注册通道不得再用「裸 ipcMain」注册（裸注册 = 无观测）', () => {
  const sources = collectMainSources();
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * 剥离注释后再做**多行**正则匹配。
   *
   * ⚠️ 这里踩过两个坑，都靠鉴别力验证才发现，记下来避免下次重犯：
   * 1. **注释误伤**：初版按「文件里是否出现 `observeIpcCall`」判定，被
   *    `handleObserved` 的文档注释（其中提到了 `observeIpcCall`）弄成**恒真** ——
   *    移除真实调用后守卫仍绿。本批已连续三次栽在此处（另两处：plugins 注释被当作
   *    二次注册、文档里的 `IPC_PERMISSION_STRICT=1|true|yes` 被当作硬编码开启）。
   * 2. **逐行漏判**：`audio-spectrum:subscribe` / `unsubscribe` 的注册是**多行**写法
   *    （`handleObserved(` 与通道名分行），逐行正则会漏掉它们，进而误报「清单与实现脱节」。
   *
   * 故改为「先剥注释，再对整份源码做多行正则」。
   */
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '/* stripped */')
      // 行注释：用 [^:] 避免误伤 `https://` 这类协议前缀
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const cleanedSources = sources.map(({ rel, source }) => ({
    rel,
    source: stripComments(source),
  }));

  const bareRegistrations: string[] = [];
  const registeredChannels = new Set<string>();

  for (const channel of EXTERNALLY_REGISTERED_CHANNELS) {
    const escaped = escapeRegex(channel);
    // `\s*` 含换行 → 同时覆盖单行与多行写法
    const bare = new RegExp(`ipcMain\\.(?:handle|on)\\(\\s*'${escaped}'`);
    const anyRegistration = new RegExp(
      `(?:handleObserved|ipcMain\\.(?:handle|on)|registerHandler|registerListener)\\(\\s*'${escaped}'`,
    );

    for (const { rel, source } of cleanedSources) {
      if (bare.test(source)) bareRegistrations.push(`${channel} → ${rel}`);
      if (anyRegistration.test(source)) registeredChannels.add(channel);
    }
  }

  assert.deepEqual(
    bareRegistrations,
    [],
    '以下通道仍在用裸 ipcMain.handle/on 注册 —— 那是**无观测**的路径，调用不可见：\n' +
      '请改用 handleObserved（本模块包装）或 ipcRegistry.registerHandler/registerListener',
  );

  // 反向确认：清单里的每条都必须真的能找到注册调用（防「清单与实现脱节」）
  const notRegistered = EXTERNALLY_REGISTERED_CHANNELS.filter(
    (channel) => !registeredChannels.has(channel),
  );
  assert.deepEqual(
    notRegistered,
    [],
    '以下通道在 EXTERNALLY_REGISTERED_CHANNELS 中，但主进程源码里找不到任何注册调用 —— ' +
      '清单已与实现脱节（通道被重命名或删除后未同步）',
  );
});

test('P-4a：本版不得开启 IPC_PERMISSION_STRICT（§6 拍板：只并入与观测，不开 strict）', () => {
  const permissions = readFileSync(
    path.join(repoRoot, 'src', 'main', 'ipc', 'permissions.ts'),
    'utf8',
  );
  // 判定函数仍须以「环境变量缺省即关闭」为默认，不得把默认值改成开启
  assert.match(
    permissions,
    /export const isStrictModeEnabled = \(value: unknown = process\.env\.IPC_PERMISSION_STRICT\)/,
    'isStrictModeEnabled 的默认入参必须仍取环境变量（即默认关闭）',
  );
  // 仓库里不得出现「为了本版顺手打开」的硬编码开启。
  // ⚠️ 必须逐行扫描并**跳过注释行**：`permissions.ts` 的文档注释里写有
  // 「环境变量 `IPC_PERMISSION_STRICT=1|true|yes` 时…」的说明，
  // 直接对整份源码做正则会把该说明误判为硬编码开启（同类误报已出现过两次）。
  const offenders: string[] = [];
  for (const { rel, source } of collectMainSources()) {
    source.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (/IPC_PERMISSION_STRICT\s*[:=]\s*(['"`])?(1|true|yes)/i.test(line)) {
        offenders.push(`${rel}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], '发现硬编码开启 IPC_PERMISSION_STRICT —— 本版按 §6 拍板不得开启');
});
