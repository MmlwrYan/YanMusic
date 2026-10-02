import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { scanDeadModules } from '../scripts/scan-dead-modules.mjs';

/**
 * v1.2.9 清债版的**源码级守卫**集合。
 *
 * 这些用例的共同点：守护的对象是「一类错误」而不是「一个函数」——
 * 它们靠静态断言锁定修复点，**改动源码即变红**，因此能防回退。
 * 每条都在注释里写明「怎样改会让它变红」（鉴别力）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * W-6：`pluginStatsAuth` 常量的**单一来源**。
 *
 * 这是跨语言契约（主进程 TS / Cloudflare Worker 纯 JS / 测试 TS 三方）：
 * 主进程此前**内联重写**了头名与环境变量名字面量，改一侧不会让另一侧报错 → 真实漂移风险。
 *
 * 怎样改会变红：把 `plugins.ts` 里的 `headers[PLUGIN_STATS_KEY_HEADER]` 改回
 * `headers['X-YanMusic-Key']` → 用例 1 变红。
 */
test('W-6：主进程不得内联统计鉴权的头名/环境变量名字面量', () => {
  const source = read('src/main/plugins.ts');
  assert.ok(
    /import \{ PLUGIN_STATS_KEY_ENV, PLUGIN_STATS_KEY_HEADER \} from '\.\.\/shared\/pluginStatsAuth';/.test(
      source,
    ),
    'plugins.ts 必须从 shared/pluginStatsAuth 导入常量（而不是内联）',
  );
  assert.ok(!/'X-YanMusic-Key'/.test(source), 'plugins.ts 仍硬编码了头名字面量 "X-YanMusic-Key"');
  assert.ok(
    !/process\.env\.yanmusic_PLUGIN_STATS_API_KEY/.test(source),
    'plugins.ts 仍硬编码了环境变量名字面量',
  );
  assert.ok(/headers\[PLUGIN_STATS_KEY_HEADER\] = statsKey/.test(source), '写入头时必须用共享常量');
});

/**
 * W-4：外链 `rel="noopener noreferrer"`。
 * 怎样改会变红：把 `sanitizeHtml` 里的 `ensureNoopenerHook()` 调用删掉 → 用例变红。
 * （只断言 `addHook` 字符串存在是不够的 —— 那样即使钩子被短路也检测不出来。）
 */
test('W-4：sanitizeHtml 必须为带 target 的外链补 rel=noopener noreferrer', () => {
  const source = read('src/renderer/utils/sanitize.ts');
  const sanitizeBody = source.match(/export const sanitizeHtml[\s\S]*?\n};/);
  assert.ok(sanitizeBody, '未找到 sanitizeHtml 定义');
  assert.ok(
    /ensureNoopenerHook\(\);/.test(sanitizeBody[0]),
    'sanitizeHtml 未调用 ensureNoopenerHook() —— 钩子未挂上等于没修',
  );
  assert.ok(
    /addHook\('afterSanitizeAttributes'/.test(source),
    '未挂 afterSanitizeAttributes 钩子 —— 外链会缺失 rel（window.opener 反向操纵面）',
  );
  assert.ok(
    /getAttribute\('rel'\)/.test(source),
    '补 rel 必须**合并**已有 token（读一下现有 rel），直接覆盖会冲掉 nofollow 等',
  );
  assert.ok(
    /tokens\.add\('noopener'\)/.test(source) && /tokens\.add\('noreferrer'\)/.test(source),
    '钩子未同时补上 noopener 与 noreferrer',
  );
  assert.ok(
    /hasAttribute\('target'\)/.test(source),
    '补 rel 必须以存在 target 为条件（无 target 的外链不需要，避免无谓改动）',
  );
  assert.ok(
    /let noopenerHookInstalled = false;/.test(source),
    '必须有「只注册一次」的保护（钩子挂在 DOMPurify 全局实例上，重复注册会累积）',
  );
});

/**
 * W-2：`runtime.ts:2787` 的三元死分支（`'idle' : 'idle'`）。
 * 怎样改会变红：把 `? 'active' : 'idle'` 改回三分支同值写法 → 变红。
 */
test('W-2：插件运行时状态不得出现同值三元（死分支）', () => {
  const source = read('src/renderer/plugins/runtime.ts');
  assert.ok(!/\? 'idle' : 'idle'/.test(source), "runtime.ts 仍存在 `? 'idle' : 'idle'` 死分支");
  assert.ok(
    /status: activePlugins\.has\(descriptor\.id\) \? 'active' : 'idle'/.test(source),
    '状态赋值应为化简后的二分支',
  );
});

/**
 * W-1：零引用模块不得新增。
 *
 * 扫描由 `scripts/scan-dead-modules.mjs` 完成（import 图 BFS，源码层，不依赖构建产物）。
 * 白名单是**本版确认后刻意保留**的项，每条都写了理由；**只减不增**——
 * 新增任何 A 类文件都会让本用例变红。
 */
test('W-1：A 类零引用模块不得超出「刻意保留」白名单', () => {
  // 直接调用函数而非 spawn 子进程：本机测试环境下 spawnSync 会返回 EBUSY（环境限制）。
  const parsed = scanDeadModules();

  /** 刻意保留清单（v1.2.9）：value = 保留理由 */
  const KEEP: Record<string, string> = {
    'src/main/cache.ts': '疑似未接线的缓存实现，删除前需确认是否有接线计划（待核定）',
    'src/renderer/composables/useLyricTimeline.ts':
      '歌词时间线，疑似重构遗留，需人工确认是否还有入口（待核定）',
    'src/renderer/stores/loginDevices.ts': '登录设备列表，需人工确认是否仍有入口（待核定）',
    'src/renderer/views/settings/components/InterfaceSettingsSection.vue':
      '设置分区，无 import 边但疑似活功能，需人工确认（待核定）',
    'src/renderer/views/settings/components/WindowSettingsSection.vue':
      '设置分区，无 import 边但疑似活功能，需人工确认（待核定）',
    'src/renderer/plugins/types.ts':
      '环境类型增强（$echo / $yanmusic），删除后 vue-tsc 不一定报错但会静默丢失插件全局类型（待核定）',
    'src/shims-vue.d.ts': '构建契约（.d.ts），删除会让 vue-tsc 找不到 .vue 模块声明',
    'src/renderer/types.d.ts': '构建契约（.d.ts），同上',
    'src/renderer/stores/persist.d.ts': '构建契约（.d.ts），为 Pinia 的 persist 选项提供类型增强',
  };

  const unexpected = parsed.A.map((a) => a.file).filter((f) => !(f in KEEP));
  assert.deepEqual(
    unexpected,
    [],
    `出现白名单外的新零引用模块（应删除或补充保留理由）：\n${unexpected.join('\n')}`,
  );

  // T 类（仅测试引用）应为 0：契约锚点都应被生产代码引用（W-6 已让 pluginStatsAuth 转为被主进程引用）
  assert.deepEqual(
    parsed.T.map((t) => t.file),
    [],
    '存在「仅被测试引用」的模块 —— 应让生产代码引用它，而不是靠测试吊着',
  );

  // B 类是插件 API 面，只允许在既有的 glob 目录内增加，不设数量阈值
  for (const b of parsed.B) {
    assert.ok(
      /^src\/renderer\/(api\/|components\/(ui|music|player)\/)/.test(b.file),
      `B 类判定异常：${b.file} 不在 import.meta.glob 覆盖目录内`,
    );
  }
});
