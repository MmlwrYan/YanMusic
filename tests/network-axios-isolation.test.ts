import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 「两个 axios 实例不同一」守卫（V4-17，v1.4.0；承接 `KNOWN-DEBT.md` 的 M-7）。
 *
 * ## 为什么它是**正确性前提**而不是风格问题
 *
 * `main/networkSettings.ts` 用**绝对路径**去 require `server/node_modules/axios`，
 * 只改**那一份** axios 的 `defaults`（timeout / adapter / proxy）——
 * 目的是「让 KuGouMusicApi 子模块拿到应用的网络默认值，同时**不动主程序自己那份**」。
 *
 * 这个设计**完全建立在「两份 axios 不是同一个模块实例」之上**：
 * 若某天两者变成同一实例（pnpm 提升、workspace 合并、子模块改用根依赖……），
 * 那么给服务端设的 adapter **会同时改掉主程序的**，表现为
 * 「主程序所有出网请求都被塞进酷狗 API 的 session 分区」—— 极难定位。
 *
 * 实测（2026-10-14）确认前提当前成立：
 *   根：`node_modules/.pnpm/axios@1.20.0_.../node_modules/axios/dist/node/axios.cjs`
 *   子模块：`server/node_modules/axios/dist/node/axios.cjs`（**实体目录**，非符号链接）
 *   `require(...) === require(server/...)` → **false**
 *
 * ## 为什么本用例会在 CI 里 skip
 *
 * `server/node_modules` 由 CI 的 **`Install server runtime dependencies`** 步骤创建，
 * 而该步骤排在 `Run unit tests` **之后**（见 `.github/workflows/build.yml`）。
 * 因此单测阶段它必然不存在 —— 此时**必须显式 skip 并标注未校验**，
 * 绝不能`assert` 通过（那会让守卫变成安慰剂，与 S-5 体积守卫同一处理原则）。
 *
 * 想让它真的跑起来就要把依赖安装提到单测之前，那是 CI 结构变更，本版**不做**
 * （避免为一个守卫重排构建顺序、增加发布路径风险）。**重启条件已写明在本条注释里。**
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const SERVER_AXIOS_PKG = path.join(repoRoot, 'server', 'node_modules', 'axios', 'package.json');

test('V4-17：根 axios 与子模块 axios 必须是**不同**的模块实例', (t) => {
  if (!existsSync(SERVER_AXIOS_PKG)) {
    t.skip(
      'server/node_modules/axios 不存在（CI 单测阶段早于 server 依赖安装）—— ' +
        '本项**未校验**，不代表通过',
    );
    return;
  }

  const rootAxios = require('axios');
  const serverAxios = require(path.join(repoRoot, 'server', 'node_modules', 'axios'));

  assert.notEqual(
    rootAxios,
    serverAxios,
    '两份 axios 变成了同一实例 —— `networkSettings.ts` 给服务端设 adapter/超时' +
      '会连带改掉主程序自己的请求行为（主程序出网会被塞进酷狗 API 分区）。' +
      '若这是 pnpm 提升策略或依赖合并导致的，必须同步改造那段「按绝对路径 require」的逻辑',
  );
  assert.notEqual(
    rootAxios.default,
    serverAxios.default,
    '两份 axios 的 default 导出是同一实例，等价于上一条失败',
  );
  assert.notEqual(
    require.resolve('axios'),
    require.resolve(path.join(repoRoot, 'server', 'node_modules', 'axios')),
    '两者解析到同一个文件路径 —— 说明模块解析被合并了，隔离前提已失效',
  );
});

test('V4-17：两份 axios 的 defaults 互不影响（隔离前提的**行为**验证）', (t) => {
  if (!existsSync(SERVER_AXIOS_PKG)) {
    t.skip('server/node_modules/axios 不存在 —— 本项**未校验**，不代表通过');
    return;
  }

  const rootAxios = require('axios');
  const serverAxios = require(path.join(repoRoot, 'server', 'node_modules', 'axios'));

  const rootTimeoutBefore = rootAxios.defaults.timeout;
  const serverTimeoutBefore = serverAxios.defaults.timeout;
  const sentinel = 987_654;

  try {
    // 模拟 `networkSettings.ts` 对**服务端那份**做的改动
    serverAxios.defaults.timeout = sentinel;
    assert.equal(
      rootAxios.defaults.timeout,
      rootTimeoutBefore,
      '改服务端 axios 的 defaults 影响到了主程序那份 —— 隔离已失效。' +
        '这正是 `networkSettings.ts` 用绝对路径 require 要防的事',
    );
    // 反向：改根那份也不该影响服务端
    rootAxios.defaults.timeout = sentinel + 1;
    assert.equal(
      serverAxios.defaults.timeout,
      sentinel,
      '改主程序 axios 的 defaults 影响到了服务端那份',
    );
  } finally {
    rootAxios.defaults.timeout = rootTimeoutBefore;
    serverAxios.defaults.timeout = serverTimeoutBefore;
  }
});

/**
 * 源码守卫：两份 axios 必须**各自**用**不同**的分区配置，且子模块那份必须
 * 按**绝对路径**加载。
 *
 * ⚠️ 只断言「`server` 出现在文件里」是假守卫（v1.3.5 的教训）。这里锚定三件事：
 *
 *   ① 子模块 axios 用 `require(path.join(..., 'node_modules', 'axios'))` 加载 ——
 *      改成裸 `require('axios')` 会拿到根实例，隔离当场失效，
 *      而两份版本号相同、`===` 比较在别处 —— 极难发现；
 *   ② 根实例配 `APP_NETWORK_SESSION_PARTITION`；
 *   ③ 子模块实例配 `KUGOU_API_SESSION_PARTITION`（**另一个**分区）。
 *
 * ⚠️ **不得**断言「本文件不许静态 import axios」—— 本文件**刻意同时使用两份**：
 * 静态 import 拿根那份给主程序用，绝对路径 require 拿子模块那份给酷狗 API 用，
 * 两者配不同分区。第一版守卫就是这么写错的（把正确实现判成违规）。
 */
test('V4-17：两份 axios 各配各的分区，且子模块那份按绝对路径加载', () => {
  const source = readFileSync(path.join(repoRoot, 'src/main/networkSettings.ts'), 'utf8');

  assert.ok(
    /require\(\s*path\.join\([^)]*'node_modules'\s*,\s*'axios'\s*\)\s*\)/.test(source),
    '子模块 axios 必须保持 `require(path.join(<serverPath>, "node_modules", "axios"))` —— ' +
      '改成裸 require("axios") 会解析到主程序那份实例，隔离静默失效',
  );

  // 根实例 → 主程序分区
  assert.ok(
    /axios\.defaults\.adapter\s*=\s*createElectronAxiosAdapter\(\s*axios\s*,\s*APP_NETWORK_SESSION_PARTITION\s*\)/.test(
      source,
    ),
    '根 axios 必须绑定 APP_NETWORK_SESSION_PARTITION',
  );

  // 子模块实例 → 酷狗分区（且必须用**刚 require 进来的那个变量**，不是根的 axios）
  assert.ok(
    /axios\.defaults\.adapter\s*=\s*createElectronAxiosAdapter\(\s*axios\s*,\s*KUGOU_API_SESSION_PARTITION\s*\)/.test(
      source,
    ),
    '子模块 axios 必须绑定 KUGOU_API_SESSION_PARTITION',
  );
});

/**
 * 两个分区常量必须**取值不同**：否则「酷狗 API 走独立分区」这件事没有发生，
 * 而上面的源码断言仍会通过（假绿）。
 *
 * 常量定义在 `main/networkPolicy.ts`（不是 networkSettings.ts —— 后者只是 import 它）。
 */
test('V4-17：APP 与酷狗 API 的 session 分区取值必须不同', () => {
  const source = readFileSync(path.join(repoRoot, 'src/main/networkPolicy.ts'), 'utf8');
  const grab = (name: string) => {
    const m = source.match(new RegExp(`export const ${name}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`));
    return m ? m[1] : '';
  };
  const appPartition = grab('APP_NETWORK_SESSION_PARTITION');
  const kugouPartition = grab('KUGOU_API_SESSION_PARTITION');

  assert.ok(appPartition, '应能取到 APP_NETWORK_SESSION_PARTITION 的字面量取值');
  assert.ok(kugouPartition, '应能取到 KUGOU_API_SESSION_PARTITION 的字面量取值');
  assert.notEqual(
    appPartition,
    kugouPartition,
    '两个 session 分区取值相同 —— 那么给酷狗 API 设独立 adapter 就没有实际隔离效果',
  );
});
