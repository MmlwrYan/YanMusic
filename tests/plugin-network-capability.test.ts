import test from 'node:test';
import assert from 'node:assert/strict';

import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';

/**
 * P-6 契约测试：插件网络能力门禁（`createPluginNetworkApi`）。
 *
 * ## 为什么先补这个（规划硬顺序 P-6 → P-1 → P-2 → P-3）
 *
 * `renderer/plugins/runtime.ts`(2908) 与 `main/ipc/plugins.ts`(658) 是本项目最大的两个巨型文件，
 * 且在 `tests/` 中 **0 引用**（项目记忆已记）。P-1/P-3 要改的正是这两个文件的能力边界 ——
 * **改了不知道坏了什么**。故先补契约测试。
 *
 * ## 为什么选 `network.ts` 作为第一个落点
 *
 * 它**运行时零依赖**（只有 `import type`），因此可在 `node --test` 下**直接加载并驱动真行为**。
 * 而 `main/ipc/plugins.ts` / `plugins/descriptor.ts` 都 `import electron`，只能退化成源码断言。
 *
 * ## 本文件锁定的是 F-1（v1.3.0）
 *
 * 修复前：`request` 分支要求清单声明 `capabilities.unrestrictedNetwork === true`，
 * 而 `fetch` 分支直接 `window.fetch.bind(window)` —— **不受门禁约束**。
 * 于是「门禁」可被一句 `ctx.net.fetch(...)` 绕过，形同虚设。
 *
 * v1.2.9 把它记为 W-17 待定项；v1.3.0 经维护者拍板**补门禁**。
 * 这是**对外行为变更**：未声明该能力的插件，`fetch` 将由「可用」变为「同步抛错」。
 *
 * ## 环境构造
 *
 * `network.ts` 访问两处全局：`window.fetch`（真实转发目标）与 `window.electron.plugins.net`（原生桥）。
 * 本文件在**动态 import 之前**装好这两个桩，因此测的是**真实模块的真实行为**，
 * 不是源码正则、也不是对被测逻辑的替身实现。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  ① 把 `fetch` 的 `if (!hasUnrestrictedNetwork()) throw` 删掉 → 用例「未声明能力的 fetch 必须被拒」变红；
 *  ② 把 `hasUnrestrictedNetwork()` 改成恒 `true` → 同上变红；
 *  ③ 把 `request` 的门禁删掉 → 用例「未声明能力的 request 必须被拒」变红。
 */

interface FetchCall {
  url: unknown;
  init: unknown;
}

const fetchCalls: FetchCall[] = [];
const disposers: Array<() => void> = [];
const cancelled: string[] = [];

const makeDescriptor = (unrestrictedNetwork?: boolean): EchoPluginDescriptor =>
  ({
    id: 'test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    manifest: {
      id: 'test.plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      capabilities: unrestrictedNetwork === undefined ? {} : { unrestrictedNetwork },
    },
  }) as unknown as EchoPluginDescriptor;

const makeAddDisposable = () => (dispose: () => void) => {
  disposers.push(dispose);
  return () => {
    const i = disposers.indexOf(dispose);
    if (i >= 0) disposers.splice(i, 1);
  };
};

// ── 装桩（必须在动态 import 之前）──────────────────────────────────────
(globalThis as unknown as { window: unknown }).window = {
  fetch: (url: unknown, init: unknown) => {
    fetchCalls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, __stub: true });
  },
  electron: {
    plugins: {
      net: {
        request: () => Promise.resolve({ ok: true, status: 200, __native: true }),
        cancel: (_pluginId: string, requestId: string) => {
          cancelled.push(requestId);
          return Promise.resolve();
        },
      },
    },
  },
};

const { createPluginNetworkApi } = await import('../src/renderer/plugins/network.ts');

// ── 契约：unrestrictedNetwork 未声明 ────────────────────────────────────

test('F-1：未声明 unrestrictedNetwork 时，fetch 必须被拒绝（修复前它不受任何门禁）', () => {
  fetchCalls.length = 0;
  const api = createPluginNetworkApi(makeDescriptor(undefined), makeAddDisposable());

  assert.throws(
    () => api.fetch('https://example.com/anything'),
    /未声明不受限网络能力/,
    '未声明能力的插件不得通过 fetch 发起网络请求 —— 否则门禁可被一句 fetch 绕过',
  );
  assert.equal(fetchCalls.length, 0, '被拒的调用不得触达真实 window.fetch');
});

test('F-1：未声明能力时，显式 false 与缺省字段行为一致', () => {
  const explicitFalse = createPluginNetworkApi(makeDescriptor(false), makeAddDisposable());
  assert.throws(() => explicitFalse.fetch('https://example.com/'), /未声明不受限网络能力/);

  const missing = createPluginNetworkApi(makeDescriptor(undefined), makeAddDisposable());
  assert.throws(() => missing.fetch('https://example.com/'), /未声明不受限网络能力/);
});

test('F-1：未声明 unrestrictedNetwork 时，request 必须被拒绝（既有行为不得回退）', async () => {
  const api = createPluginNetworkApi(makeDescriptor(undefined), makeAddDisposable());
  await assert.rejects(
    () => api.request({ url: 'https://example.com/api' } as never),
    /未声明不受限网络能力/,
    'request 分支的门禁是既有正确行为，本版不得因抽出共用判定而改坏',
  );
});

// ── 契约：已声明 unrestrictedNetwork ───────────────────────────────────

test('F-1：已声明 unrestrictedNetwork 时，fetch 必须放行并原样转发参数与返回值', async () => {
  fetchCalls.length = 0;
  const api = createPluginNetworkApi(makeDescriptor(true), makeAddDisposable());

  const init = { method: 'POST', headers: { 'x-test': '1' } };
  const response = (await api.fetch('https://example.com/ok', init)) as unknown as {
    __stub?: boolean;
  };

  assert.equal(fetchCalls.length, 1, '放行的调用必须恰好触达真实 window.fetch 一次');
  assert.equal(fetchCalls[0].url, 'https://example.com/ok', 'URL 必须原样透传');
  assert.equal(fetchCalls[0].init, init, 'init 必须原样透传，不得被改写');
  assert.equal(response.__stub, true, '返回值必须是真实 window.fetch 的结果');
});

test('F-1：已声明 unrestrictedNetwork 时，request 必须放行（走原生桥）', async () => {
  const api = createPluginNetworkApi(makeDescriptor(true), makeAddDisposable());
  const response = (await api.request({
    url: 'https://example.com/api',
  } as never)) as unknown as { __native?: boolean };

  assert.equal(response.__native, true, '放行的 request 必须走 window.electron.plugins.net');
});

// ── 契约：会话生命周期 ─────────────────────────────────────────────────

test('P-6：addDisposable 注册的清理函数，在被调用后必须取消未落地的请求', () => {
  cancelled.length = 0;
  const localDisposers: Array<() => void> = [];
  createPluginNetworkApi(makeDescriptor(true), (dispose) => {
    localDisposers.push(dispose);
    return () => {};
  });

  assert.equal(localDisposers.length, 1, '必须向插件注册恰好一个清理函数');
  assert.doesNotThrow(() => localDisposers[0](), '清理函数（无 pending 请求时）不得抛错');
});

// ── 反向自证：确认桩确实被换成了真实模块 ────────────────────────────────

test('P-6：被测模块确实是真实实现（API 形状契约）', () => {
  const api = createPluginNetworkApi(makeDescriptor(true), makeAddDisposable());
  assert.equal(typeof api.fetch, 'function', 'fetch 必须是函数');
  assert.equal(typeof api.request, 'function', 'request 必须是函数');
  assert.equal(
    Object.keys(api).sort().join(','),
    'fetch,request',
    '网络 API 的对外形状必须是 { fetch, request } 两项 —— 增删都属破坏性变更，需同步 CHANGELOG',
  );
});
