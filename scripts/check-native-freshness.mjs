/**
 * 原生层「产物新鲜度」判据（V4-01，v1.4.0）。
 *
 * ## 它防什么
 *
 * `.node` 产物在 `.gitignore` 里（不会入库），而 `cargo check` / `napi build`
 * 在**本机长期跑不通**（见下），于是本机出现过这种状态：
 *
 *   `.node` 的 mtime = 2026-09-25，而它的 `.rs` 最新改动 = 2026-09-27
 *
 * 也就是说 **`verify.ps1 -SkipNative` 报「全绿」，但那份绿是在旧二进制上取得的**。
 * 这类「假绿」比失败更危险 —— 它让人以为验证过了。
 *
 * ## 为什么不直接判 fail
 *
 * `.node` 不存在是**正常状态**（干净检出、CI 首次构建前都没有）。
 * 所以：
 *   - **产物缺失 → skip 并显式标注「未校验」**（沿用 S-5 体积守卫的语义，
 *     静默通过会让守卫变安慰剂）；
 *   - **产物存在但比源码旧 → 明确失败**（这才是要抓的形态）。
 *
 * ## 本机 `cargo` 为什么长期跑不通（根因已定位，2026-10-14）
 *
 * 历史记录把它写成「代理 502」，**与真实根因不符**，直接导致 N 组技术债被反复推迟：
 * `~/.cargo/config.toml` 把 crates-io 替换成了**清华 TUNA 镜像**，而该镜像已不可达。
 * 换 USTC 稀疏索引后 `cargo check --workspace` 立刻 exit 0。
 *
 * 因此本模块另提供 {@link parseCargoSourceReplacement} 与
 * {@link describeCargoMirrorDiagnosis}，让「镜像不可达」这件事**有明确诊断**，
 * 而不是留一句 `502` 让人继续误判成网络问题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 四个原生 addon 的目录名（与 `Cargo.toml` workspace members 一致）。 */
export const NATIVE_ADDON_DIRS = [
  'yan-media-controls',
  'yan-mpv-player',
  'yan-spectrum-capture',
  'yan-storage',
];

/** 参与新鲜度比较的源文件扩展名（`.rs` 源码 + 清单：改依赖同样要重编）。 */
const SOURCE_EXTENSIONS = new Set(['.rs', '.toml']);

const walkSources = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过构建产物与依赖目录（target/ 里有几万个文件，白扫会拖垮本机）
      if (['target', 'node_modules', '.git'].includes(entry.name)) continue;
      walkSources(full, out);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
};

/** 取某个 crate 下最新的源文件（`.rs` / `Cargo.toml`）。 */
export const findNewestSource = (crateDir) => {
  const files = walkSources(crateDir);
  let newest = null;
  for (const file of files) {
    const stat = fs.statSync(file);
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: file, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
};

/**
 * 检查四个原生 addon 的产物新鲜度。
 *
 * @returns `{ present, addons: [{ name, binaryPath, binaryMtimeMs, newestSourcePath,
 *            newestSourceMtimeMs, stale, missing }], staleAddons, missingAddons }`
 *   `present === false` 表示**没有任何产物存在**（干净检出）—— 调用方应 skip 并标注未校验。
 */
export const checkNativeFreshness = ({
  root = process.cwd(),
  addonDirs = NATIVE_ADDON_DIRS,
} = {}) => {
  const nativeRoot = path.join(root, 'native');
  const addons = [];

  for (const name of addonDirs) {
    const crateDir = path.join(nativeRoot, name);
    const binaryPath = path.join(crateDir, `${name}.node`);
    const binaryExists = fs.existsSync(binaryPath);
    const newest = findNewestSource(crateDir);

    const binaryMtimeMs = binaryExists ? fs.statSync(binaryPath).mtimeMs : 0;
    const newestSourceMtimeMs = newest ? newest.mtimeMs : 0;
    // 只在「产物存在 且 有源可依」时才判陈旧；缺任一都不构成「陈旧」结论
    const stale = binaryExists && Boolean(newest) && newestSourceMtimeMs > binaryMtimeMs;

    addons.push({
      name,
      binaryPath,
      binaryExists,
      binaryMtimeMs,
      newestSourcePath: newest?.path ?? '',
      newestSourceMtimeMs,
      stale,
      missing: !binaryExists,
    });
  }

  const present = addons.some((item) => item.binaryExists);
  return {
    present,
    addons,
    staleAddons: addons.filter((item) => item.stale),
    missingAddons: addons.filter((item) => item.missing),
  };
};

/**
 * 解析 `~/.cargo/config.toml` 里 `[source.crates-io] replace-with` 指向的镜像。
 *
 * 只做**极简 TOML 解析**：本文件只关心 `replace-with = "x"` 与
 * `[source.x] registry = "..."` 两行，引入 TOML 库不值得。
 * 解析不到时返回 `null`（调用方据此跳过镜像检查，而不是报错）。
 */
export const parseCargoSourceReplacement = (configText) => {
  if (typeof configText !== 'string' || !configText) return null;

  const cratesIoBlock = configText.match(/\[source\.crates-io\]([\s\S]*?)(?=\n\[|$)/);
  if (!cratesIoBlock) return null;
  const replaceWith = cratesIoBlock[1].match(/replace-with\s*=\s*"([^"]+)"/);
  if (!replaceWith) return null;

  const alias = replaceWith[1];
  // 别名里可能含 `.` 之类需要转义的字符，故不直接拼进正则
  const blockRe = new RegExp(`\\[source\\.${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
  const block = configText.match(blockRe);
  if (!block || block.index === undefined) return { alias, registry: '' };
  const rest = configText.slice(block.index);
  const registry = rest.match(/registry\s*=\s*"([^"]+)"/);
  return { alias, registry: registry ? registry[1] : '' };
};

/** 从 `sparse+https://host/path/` 里取出去掉 `sparse+` 前缀的可探测 URL。 */
export const toProbeUrl = (registry) => {
  const raw = String(registry ?? '').replace(/^sparse\+/i, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/?$/, '/')}config.json`;
  } catch {
    return '';
  }
};

/**
 * 生成**根因明确**的镜像诊断文案。
 *
 * 这条文案存在的唯一理由：历史上同一故障被写成「代理 502」，
 * 于是没人去查镜像，N 组技术债白挂了两周。
 */
export const describeCargoMirrorDiagnosis = ({ alias, registry, probeUrl, reason }) => {
  const lines = [
    '原生构建无法进行：cargo 源镜像不可达。',
    '',
    `  配置项： [source.crates-io] replace-with = "${alias}"`,
    `  镜像址： ${registry || '(未在 config.toml 里找到 registry 字段)'}`,
    probeUrl ? `  探测址： ${probeUrl}` : '',
    reason ? `  实际错误： ${reason}` : '',
    '',
    '这不是「代理 502」，也不是代码问题 —— 是**镜像本身**不可达。',
    '可用解法（择一）：',
    '  ① 换一个可达的镜像（实测 USTC 可用）：',
    '       [source.ustc]',
    '       registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"',
    '     并把 replace-with 改为 "ustc"；',
    '  ② 删掉 replace-with，直连 sparse+https://index.crates.io/（本机实测可达）；',
    '  ③ 确认 `cargo check --offline` 能否命中本地缓存（缓存足够时无需联网）。',
    '',
    '⚠️ 修改 ~/.cargo/config.toml 前请先备份 —— 这是**全局**配置。',
  ];
  return lines.filter((line) => line !== '').join('\n');
};

/** 本机 cargo 全局配置路径（尊重 CARGO_HOME）。 */
export const resolveCargoConfigPath = () => {
  const home = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const toml = path.join(home, 'config.toml');
  const legacy = path.join(home, 'config');
  if (fs.existsSync(toml)) return toml;
  if (fs.existsSync(legacy)) return legacy;
  return '';
};

// ─────────────────────────── CLI ───────────────────────────

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  let failed = 0;

  // ① 产物新鲜度
  console.log('== 原生产物新鲜度 ==');
  const freshness = checkNativeFreshness({ root: process.cwd() });
  if (!freshness.present) {
    console.log('… 四个 addon 的 .node 均不存在（干净检出）—— 本项**未校验**，不代表通过');
    console.log('   构建后可复跑本脚本；产物在 .gitignore 中不入库。');
  } else {
    for (const item of freshness.addons) {
      if (item.missing) {
        console.log(`… ${item.name}: 产物缺失（**未校验**）`);
        continue;
      }
      const fmt = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '(无)');
      if (item.stale) {
        console.log(`❌ ${item.name}: 产物比源码旧`);
        console.log(
          `     产物 ${fmt(item.binaryMtimeMs)}  <  源码 ${fmt(item.newestSourceMtimeMs)}`,
        );
        console.log(`     源码: ${path.relative(process.cwd(), item.newestSourcePath)}`);
        console.log('     → 重新构建该 addon 后再取证；在旧二进制上取得的「绿」不算验证。');
        failed += 1;
      } else {
        console.log(`✅ ${item.name}: 产物不早于源码（${fmt(item.binaryMtimeMs)}）`);
      }
    }
  }

  // ② cargo 镜像可达性（只为**诊断**，不作为失败判据 —— 离线也能正常构建）
  console.log('\n== cargo 源镜像诊断 ==');
  const configPath = resolveCargoConfigPath();
  if (!configPath) {
    console.log('… 未找到 ~/.cargo/config.toml —— 走 crates-io 直连，无需检查');
  } else {
    const replacement = parseCargoSourceReplacement(fs.readFileSync(configPath, 'utf8'));
    if (!replacement) {
      console.log(`… ${configPath} 未设置 [source.crates-io] replace-with —— 走直连`);
    } else {
      const probeUrl = toProbeUrl(replacement.registry);
      console.log(`配置: ${configPath}`);
      console.log(`镜像: ${replacement.alias} → ${replacement.registry || '(无 registry 字段)'}`);
      if (!probeUrl) {
        console.log('… 镜像地址无法构造探测 URL，跳过可达性检查（不影响构建）');
      } else {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const response = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
          clearTimeout(timer);
          if (response.ok) {
            console.log(`✅ 镜像可达（HTTP ${response.status}）`);
          } else {
            console.log(`⚠️ 镜像返回 HTTP ${response.status} —— 构建可能失败`);
            console.log(
              describeCargoMirrorDiagnosis({
                ...replacement,
                probeUrl,
                reason: `HTTP ${response.status}`,
              }),
            );
          }
        } catch (error) {
          const reason =
            error?.name === 'AbortError' ? '探测超时（8s）' : String(error?.message ?? error);
          console.log(`❌ 镜像不可达：${reason}`);
          console.log('');
          console.log(describeCargoMirrorDiagnosis({ ...replacement, probeUrl, reason }));
        }
      }
    }
  }

  if (failed > 0) {
    console.error(`\n❌ 原生产物新鲜度检查未通过（${failed} 个 addon 的产物比源码旧）`);
    process.exit(1);
  }
  console.log('\n✅ 原生产物新鲜度检查通过');
  process.exit(0);
}
