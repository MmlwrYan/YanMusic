import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 一级漏洞的**结构性回归守卫**（v1.2.4）。
 *
 * 这些用例不依赖 Electron 运行时，因此可以在 `node --test` 下跑；
 * 它们校验的是「修复点还在不在」——即防止后续重构把闸门悄悄拆掉。
 * 运行时行为另由 tests/ci-supply-chain.test.ts 与人工重放覆盖。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * ⚠️ 编号对照表（W-16，v1.2.9）——**引用编号时必须带版本号**，否则必然撞号：
 *
 * | 本报告/版本 | 编号 | 含义 |
 * |---|---|---|
 * | v1.2.3 报告 | `H-2` | 插件在主渲染上下文执行（执行模型） |
 * | v1.2.5 报告 | `H-1` | 同上（v1.2.3 的 `H-2` 在新报告里的编号） |
 * | v1.2.5 报告 | `H-2` | 凭据**运行时**可经 `storage:kv:get` 读走（v1.2.6 已修，守卫见 `tests/sensitive-kv-access.test.ts`） |
 * | v1.2.3 报告 | `M-2` | `getPluginFileUrl` / `listPluginImageFiles` **无能力门禁**（v1.2.4 已修） |
 * | **本文件** | ~~`H-2`~~ → `M-2(v1.2.3)` | **本文件守的是 v1.2.3 的 `M-2`，不是 `H-2`** |
 *
 * 为何必须改名：本文件原先三条用例自称 `H-2`，容易让下一次审阅误判
 * 「一级 H-2 已有回归守卫」—— 而真正的 H-2 在 v1.2.6 之前**一条守卫都没有**。
 */

/**
 * M-2（v1.2.3 编号；≠ v1.2.5 报告的 H-2）：插件本地文件访问必须处处过 `localFiles` 能力闸门。
 *
 * 复现（修复前）：`getPluginFileUrl(filePath)` 只收路径，不查能力；
 * `listPluginImageFiles(directoryPath)` 连 pluginId 都没有。任何插件都能把任意
 * 绝对路径转成 file:// URL 或枚举任意目录的图片，绕过 `capabilities.localFiles`
 * 与「插件安全模式」→ 任意本地文件读取（CWE-22 / CWE-200）。
 */
test('M-2(v1.2.3)：所有插件文件入口都必须带 pluginId 并调用 capability 闸门', () => {
  const source = read('src/main/plugins.ts');

  // 1) 这两个函数必须显式声明 pluginId 形参
  const fileUrlSig = source.match(/export const getPluginFileUrl\s*=\s*\(([^)]*)\)/s);
  assert.ok(fileUrlSig, '未找到 getPluginFileUrl 定义');
  assert.ok(
    /pluginId/.test(fileUrlSig[1]),
    'getPluginFileUrl 缺少 pluginId 形参 —— 又退化成「任意路径转 URL」了',
  );

  const imageSig = source.match(/export const listPluginImageFiles\s*=\s*\(([^)]*)\)/s);
  assert.ok(imageSig, '未找到 listPluginImageFiles 定义');
  assert.ok(/pluginId/.test(imageSig[1]), 'listPluginImageFiles 缺少 pluginId 形参');

  // 2) 两个函数体内都必须出现过 capability 校验调用
  const bodyOf = (name: string) => {
    const start = source.indexOf(`export const ${name}`);
    assert.ok(start >= 0, `未找到 ${name}`);
    // 取到下一个顶层 export 之前
    const rest = source.slice(start + 1);
    const nextExport = rest.indexOf('\nexport ');
    return nextExport === -1 ? rest : rest.slice(0, nextExport);
  };

  assert.ok(
    /hasPluginLocalFilesAccess\s*\(/.test(bodyOf('getPluginFileUrl')),
    'getPluginFileUrl 未调用 hasPluginLocalFilesAccess —— 能力闸门缺失',
  );
  assert.ok(
    /hasPluginLocalFilesAccess\s*\(/.test(bodyOf('listPluginImageFiles')),
    'listPluginImageFiles 未调用 hasPluginLocalFilesAccess —— 能力闸门缺失',
  );

  // 3) IPC 层必须把 pluginId 透传下去（否则闸门拿到的是空值）
  const ipc = read('src/main/ipc/plugins.ts');
  assert.ok(
    /['"]plugins:fs:get-file-url['"][\s\S]{0,200}?getPluginFileUrl\(\s*pluginId/.test(ipc),
    'plugins:fs:get-file-url 未把 pluginId 传给 getPluginFileUrl',
  );
  assert.ok(
    /['"]plugins:fs:list-image-files['"][\s\S]{0,250}?listPluginImageFiles\(\s*pluginId/.test(ipc),
    'plugins:fs:list-image-files 未把 pluginId 传给 listPluginImageFiles',
  );
});

test('M-2(v1.2.3)：渲染层包装必须把内部 pluginId 注入 fs 调用（插件无法自证身份）', () => {
  const runtime = read('src/renderer/plugins/runtime.ts');
  assert.ok(
    /getFileUrl\s*:\s*\(filePath[^)]*\)\s*=>\s*getFsApi\(\)\?\.getFileUrl\(pluginId,/.test(runtime),
    'runtime.ts 的 getFileUrl 未注入 pluginId',
  );
  assert.ok(
    /listImageFiles\([\s\S]{0,120}?pluginId,/.test(runtime),
    'runtime.ts 的 listImageFiles 未注入 pluginId',
  );

  // plugin-window 独立窗口的 shim 同样必须注入
  const pluginWindow = read('src/plugin-window/main.ts');
  assert.ok(
    /getFileUrl\(descriptor\.id,/.test(pluginWindow),
    'plugin-window shim 的 getFileUrl 未注入 descriptor.id',
  );
  assert.ok(
    /listImageFiles\(descriptor\.id,/.test(pluginWindow),
    'plugin-window shim 的 listImageFiles 未注入 descriptor.id',
  );
});

test('M-2(v1.2.3)：getPluginFileUrl 必须 realpath 解析后再判定（防符号链接跳转）', () => {
  const source = read('src/main/plugins.ts');
  const start = source.indexOf('export const getPluginFileUrl');
  const body = source.slice(start, start + 1200);
  assert.ok(/realpathSync\(/.test(body), 'getPluginFileUrl 未做 realpath 解析');
  assert.ok(/isFile\(\)/.test(body), 'getPluginFileUrl 未校验目标是常规文件');
});

/**
 * H-3：登录凭据必须加密落盘。
 *
 * 复现（修复前）：`src/main/storage/kv.ts` 的 `set()` 直接
 * `kvSet(key, JSON.stringify(value))`，明文写入原生 SQLite；而登录态
 * （`pinia:user`，含 Kugou `token`）正是经 `sqlitePersistPlugin` 走这条路径落盘。
 * 任何能读磁盘的进程都可直接取走票据（CWE-312 / CWE-522）。
 */
test('H-3：KvStorage 必须对敏感键启用 safeStorage 加密', () => {
  const source = read('src/main/storage/kv.ts');

  assert.ok(/safeStorage/.test(source), 'kv.ts 未引入 safeStorage');
  assert.ok(
    /ENCRYPTED_KV_KEYS[\s\S]{0,300}?pinia:user/.test(source),
    '敏感键清单里没有 pinia:user（登录态）',
  );
  assert.ok(/encryptString\(/.test(source), '未调用 safeStorage.encryptString');
  assert.ok(/decryptString\(/.test(source), '未调用 safeStorage.decryptString');
  // 加密不可用时必须拒绝写入，而不是静默落明文
  assert.ok(
    /isEncryptionAvailable\(\)[\s\S]{0,200}?throw/.test(source),
    '加密不可用时未抛错 —— 存在静默降级为明文的路径',
  );
});

test('H-3：敏感键读写都必须过编解码变换（set/applyBatch/get 三处）', () => {
  const source = read('src/main/storage/kv.ts');

  // set() 与 applyBatch() 的写入路径都必须经 encodeForWrite
  const setBody = source.slice(
    source.indexOf('  set(key: string'),
    source.indexOf('  applyBatch('),
  );
  assert.ok(/encodeForWrite\(/.test(setBody), 'KvStorage.set 未过加密变换');

  const applyBody = source.slice(
    source.indexOf('  applyBatch('),
    source.indexOf('  delete(key: string'),
  );
  assert.ok(/encodeForWrite\(/.test(applyBody), 'KvStorage.applyBatch 未过加密变换');

  const getBody = source.slice(
    source.indexOf('  get<T>(key: string'),
    source.indexOf('  set(key: string'),
  );
  assert.ok(/decodeAfterRead\(/.test(getBody), 'KvStorage.get 未过解密变换');
});

test('H-3：非敏感键不得被误加密（避免无谓的解密失败面）', () => {
  const source = read('src/main/storage/kv.ts');
  // 敏感键清单应保持「白名单」语义：只有 pinia:user 等少数键
  const listMatch = source.match(/ENCRYPTED_KV_KEYS[^=]*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(listMatch, '未找到 ENCRYPTED_KV_KEYS 清单');
  const entries = listMatch[1]
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .filter((s) => /^['"]/.test(s));
  assert.ok(entries.length > 0, '敏感键清单为空 —— 加密形同虚设');
  assert.ok(
    entries.length <= 6,
    `敏感键清单有 ${entries.length} 项，疑似把普通设置键也加了进来；应当只列凭据类键`,
  );
  assert.ok(
    entries.every((e) => !/setting|theme|player|playlist/i.test(e)),
    '敏感键清单里出现了普通设置键',
  );
});
