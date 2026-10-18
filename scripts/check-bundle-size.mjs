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
 * **它必须等于「当前已发布版本的实测值」。** 每次发版前重新校准 ——
 * 这是本常量的**唯一**正确用法，也是本项（V4-12）存在的理由：
 * 容忍带是「允许**单次**改动临时超出的幅度」，**不是「可以有 2% 的长期水位」**。
 *
 * ## 三次校准的记录（都留档，因为「为什么是这个数」比数字本身重要）
 *
 * 1. v1.4.0：旧基线取自 v1.2.9（1,128,926 B），而 v1.3.7 实测已是 1,131,118 B。
 *    差的 2,192 B **被容忍带吃掉** —— 于是 `预算 − 当前体积` 打印出来有 20,386 B，
 *    看起来宽松，**真正可用的余量其实只剩约 314 B**。本次把基线对齐到 v1.3.7 实测值。
 *
 * 2. v1.4.0 发版时**再次校准**到本版实测 1,133,086 B。
 *    ⚠️ 这一步是**必须**的，而不是可选的美化：v1.4.0 相对 v1.3.7 净增 1,968 B，
 *    若不校准，`实测(1,133,086) > 基线(1,131,118)` —— 基线**当场就过时了**，
 *    容忍带又被吃掉 1,968 B（只剩约 20,654 B）。
 *    **这条陷阱很隐蔽**：`checkBundleSize()` 仍会报「在预算内」，
 *    只有把「实测 vs 基线」单独看才看得出来。守卫已按这个口径加固（见下）。
 *
 * 3. v1.4.1：Dependabot 依赖合并后实测 1,134,751 B（**+1,665 B**
 *    = 运行时组 `reka-ui` 等 +2,874 B，开发组构建链 −1,209 B）。
 *    这次校准**不是**走过场 —— 上一次加的那条守卫（「基线不得落后于实测」）
 *    在依赖合并后**立刻变红**，报错信息直接给出了该改成什么数。
 *    也就是说：**那道守卫按设计工作了**，它把「发版时必须校准」变成了
 *    一个不会忘记的动作。
 *
 * 4. v2.0.0：新增**网易云音源**（搜索音源切换 + 取链 + 歌词）后实测 1,136,233 B
 *    （**+1,482 B**，主要是 `search/searchHelpers` 里新增的音源枚举与标签 ——
 *    该模块本就在首屏）。
 *    把握住了纪律：**网易云的对象归一化刻意放在主进程**
 *    （`src/main/netease/map.ts`），所以渲染进程只多了「一个 if 分支 + 一个瘦 API 封装」，
 *    增量只有旧容忍带（22,695 B）的 **6.5%**。
 *    若把映射搬到渲染进程，增量会明显更大 —— 这条注释就是那次取舍的留痕。
 *
 * ## 当前状态（v2.0.0）
 *
 * 实测 1,138,641 B；预算 = 1,138,641 × 1.02 = 1,161,413 B；
 * 容忍带 22,772 B **全部可用**。
 *
 * ⚠️ v2.0.0 相对 v1.3.7 的 1,131,118 B 净增 7,523 B ——
 * 来自酷我 / JOOX 两个音源的渲染层接缝（两个瘦 API 封装 + 搜索页的三分支）。
 * 与网易云同一套取舍：**对象归一化放在主进程**，渲染进程只多「一个 if 分支 +
 * 一个瘦封装」，所以两个新音源合计只吃了 7.5 KB。
 * 若哪天把映射搬到渲染进程，这里会立刻炸 —— 那时应当先看一眼再做。
 *
 * 真正收紧仍要靠腾挪，见 `docs/agent/v1.4.0/` 的 V4-11 取证
 * （约 258 KB 可腾挪，但需要改启动顺序 + 可靠的 GUI 自动化去验证）。
 */
export const ENTRY_BASELINE_BYTES = 1138641;

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
