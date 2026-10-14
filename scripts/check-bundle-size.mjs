/**
 * 首屏入口资源体积守卫（S-5，v1.3.0；源自 v1.2.9 规划的 B-2，当时未做）。
 *
 * **它防什么**：只防「回退」。随着功能增加体积自然上涨是正常的，但**无意中把
 * 大依赖引进入口链**、或**把本该懒加载的模块拽回首屏**会让冷启动明显变慢，
 * 而这类问题在 code review 里几乎看不出来（改的往往只是一行 import）。
 *
 * **口径（务必与测试保持一致）**：统计 `dist/index.html` 里**入口直接引用**的资源：
 *   - `<script src>` / `<link href>` 指向的 `.js` / `.css`；
 *   - `<link rel="modulepreload" href>` 指向的 `.js`。
 * 去重后求和。**不统计**动态 import 的懒加载 chunk（它们不进首屏）。
 *
 * **两种用法，语义不同**（这是本文件最容易用错的地方）：
 *   - 作为**库**被测试调用（`tests/bundle-size-guard.test.ts`）：CI 里 `Run unit tests`
 *     早于 `Build desktop app`，**读不到产物** → 那时必须 `skip` 并显式标注「未校验」，
 *     **绝不能静默通过**（否则守卫变成安慰剂）。
 *   - 作为**CLI** 被 `scripts/verify.ps1` 在 `vite build` 之后调用：此时**没有产物
 *     就是异常**，必须非 0 退出。
 *
 * 用法：
 *   node scripts/check-bundle-size.mjs          # CLI（无产物 = 失败）
 *   import { checkBundleSize } from '.../check-bundle-size.mjs'
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(selfPath), '..');

/**
 * 首屏入口资源合计字节的基线。
 *
 * **为什么在 v1.4.0 从 1,128,926 上调到 1,131,118**（V4-12）：
 *
 * 旧基线取自 v1.2.9（1,128,926 B），而 v1.3.7 实测已是 1,131,118 B。
 * 两者相差 2,192 B，而容忍带是 +2% = 22,579 B —— 也就是说
 * **容忍带被「历史漂移」吃掉了 2,192 B，真正留给未来的余量只剩约 20 KB**，
 * 而「预算 1,151,504 B − 当前 1,131,118 B = 20,386 B」这个看似宽松的数字里，
 * 有 2,192 B 其实早已被消耗掉。
 *
 * 把基线对齐到**当前已发布版本（v1.3.7）的实测值**，语义才是干净的：
 *   - 基线 = 「截至 v1.3.7，这个体积是被接受过的」；
 *   - 容忍带 = 「允许下一次改动临时超出的幅度」。
 *
 * ⚠️ **这不是放宽门槛，而是把门槛重新校准到它本来声称的位置。**
 * 校准前：守卫允许的最大值 1,151,504 B（相对 v1.2.9 基线 +2%）；
 * 校准后：守卫允许的最大值 1,153,740 B（相对 v1.3.7 基线 +2%）——
 * 绝对值仅上移 2,236 B，与「把已发生的正常增长计入基线」的量级一致。
 *
 * 收紧门槛是 V4-11（首屏腾挪）的目标：腾挪完成后应把基线**下调**到腾挪后的实测值。
 */
export const ENTRY_BASELINE_BYTES = 1131118;

/**
 * 容忍带：+2%。
 *
 * **语义（V4-12 明确写清，此前只是隐含）**：
 * 「允许**单次**改动临时超出的幅度」，不是「可以有 2% 的长期水位」。
 *
 * 因此正确用法是：**每次正式发版时把基线校准到该版本的实测值**，
 * 让容忍带始终只覆盖「尚未发版的在途改动」。若不校准，容忍带会逐版累积，
 * 最终变成一条永远碰不到的死线（v1.4.0 校准前就是这个状态：
 * 真正可用的余量只剩约 314 B）。
 */
export const ENTRY_TOLERANCE_RATIO = 0.02;

const SCRIPT_SRC_RE = /<script[^>]+src="([^"]+\.js)"/g;
const LINK_HREF_RE = /<link[^>]+href="([^"]+\.(?:js|css))"/g;

const toFile = (root, url) => path.join(root, 'dist', url.replace(/^\//, ''));

/**
 * 执行一次体积检查。
 * @returns `{ ok, present, totalBytes, budgetBytes, entryCount, missing }`
 *   `present === false` 表示产物不存在（dist/index.html 缺失）—— 调用方需自行决定
 *   该视作「跳过」还是「失败」。
 */
export const checkBundleSize = ({
  root = ROOT,
  baselineBytes = ENTRY_BASELINE_BYTES,
  tolerance = ENTRY_TOLERANCE_RATIO,
} = {}) => {
  const indexHtml = path.join(root, 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return { ok: false, present: false, totalBytes: 0, budgetBytes: 0, entryCount: 0, missing: [] };
  }

  const html = fs.readFileSync(indexHtml, 'utf8');
  const refs = new Set();
  for (const re of [SCRIPT_SRC_RE, LINK_HREF_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) refs.add(m[1]);
  }

  let totalBytes = 0;
  const missing = [];
  for (const ref of refs) {
    const file = toFile(root, ref);
    if (fs.existsSync(file)) totalBytes += fs.statSync(file).size;
    else missing.push(ref);
  }

  const budgetBytes = Math.floor(baselineBytes * (1 + tolerance));
  return {
    ok: totalBytes <= budgetBytes,
    present: true,
    totalBytes,
    budgetBytes,
    entryCount: refs.size,
    missing,
  };
};

/** 是否需要 CLI 行为（本文件被直接执行） */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === selfPath;

if (isDirectRun) {
  const result = checkBundleSize();
  if (!result.present) {
    console.error('❌ 未找到 dist/index.html —— 本检查必须在 `vite build` 之后运行');
    console.error(
      '   （若在 WorkBuddy 等沙箱中构建失败，见项目记忆：node-safe-delete 会拦 dist 清理，先移走 dist/ 再构建）',
    );
    process.exit(1);
  }
  const kib = (n) => (n / 1024).toFixed(1);
  console.log(
    `首屏入口资源 ${result.entryCount} 个 / ${result.totalBytes} B (${kib(result.totalBytes)} KiB) ` +
      `/ 预算 ${result.budgetBytes} B (${kib(result.budgetBytes)} KiB)`,
  );
  if (result.missing.length) {
    console.warn(`⚠️ ${result.missing.length} 个入口引用在磁盘上不存在（引用了未产出的文件）：`);
    for (const m of result.missing.slice(0, 5)) console.warn(`   ${m}`);
  }
  if (!result.ok) {
    console.error(
      `❌ 首屏体积超出预算 ${result.totalBytes - result.budgetBytes} B —— ` +
        `检查是否有大依赖被引入入口链，或本应懒加载的模块被拽回首屏`,
    );
    process.exit(1);
  }
  console.log('✅ 首屏体积在预算内');
  process.exit(0);
}
