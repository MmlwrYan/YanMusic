import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubtreeQuarantineRegistry } from '../src/renderer/plugins/subtreeQuarantine.ts';

/**
 * P-5（v1.3.0）守卫：插件 UI 子树隔离注册表。
 *
 * ## 为什么需要
 *
 * 插件与宿主**同 realm、同事件循环**（H-1 结论）。此前插件组件抛错时，
 * Vue 的 `errorHandler` 只做**记录 + 上报** —— 出错的组件树仍留在页面上
 *（半渲染状态，并在后续更新中反复抛错），用户看到「某块坏了但没有任何说明」。
 *
 * 规划 §2.2 P-5 要求「至少做到插件 UI 子树出错只卸载该子树 + 明确提示」。
 * 本文件锁定其中的**注册表语义**（注册/隔离/注销/容错）——
 * 它是零依赖的，故可直接驱动真行为；DOM 渲染部分在 `runtime.ts` 内，
 * **无法在 node 下单测**（此处如实标注，不假装覆盖了它）。
 *
 * 边界：死循环/长任务类故障**无法在 JS 层防**（同事件循环），
 * 那一类靠 P-1 收窄破坏面 + 记录为残余风险，真隔离留给 v1.4.0。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `quarantine` 的 `for (const handler of [...set])` 改成直接 `return false`
 *  （即不调用任何 handler）→ 用例 1、2 变红。
 */

test('P-5：quarantine 必须调用该插件的隔离回调（不只是返回 true）', () => {
  const registry = createSubtreeQuarantineRegistry();
  const calls: Array<{ error: unknown; info?: string }> = [];

  const off = registry.register('plugin.a', (error, info) => calls.push({ error, info }));
  assert.equal(registry.countOf('plugin.a'), 1);

  const boom = new Error('组件渲染失败');
  const handled = registry.quarantine('plugin.a', boom, 'Vue 组件: render');

  assert.equal(handled, true, '有活动挂载点时应返回 true');
  assert.equal(calls.length, 1, '隔离回调必须被调用 —— 只返回 true 而不卸载子树等于没做事');
  assert.equal(calls[0].error, boom);
  assert.equal(calls[0].info, 'Vue 组件: render');

  off();
});

test('P-5：同一插件的多个挂载点必须**全部**被隔离', () => {
  const registry = createSubtreeQuarantineRegistry();
  let first = 0;
  let second = 0;

  registry.register('plugin.multi', () => {
    first += 1;
  });
  registry.register('plugin.multi', () => {
    second += 1;
  });
  assert.equal(registry.countOf('plugin.multi'), 2);

  registry.quarantine('plugin.multi', new Error('x'));

  assert.equal(first, 1, '第一个挂载点必须被隔离');
  assert.equal(second, 1, '第二个挂载点也必须被隔离（宿主只拿到 pluginId，无法只摘一个）');
});

test('P-5：注销后不得再被隔离，且不残留空集合（防长跑内存增长）', () => {
  const registry = createSubtreeQuarantineRegistry();
  let calls = 0;
  const off = registry.register('plugin.b', () => {
    calls += 1;
  });

  off();
  assert.equal(registry.countOf('plugin.b'), 0, '注销后必须清掉空集合，否则 Map 会无限增长');

  const handled = registry.quarantine('plugin.b', new Error('x'));
  assert.equal(handled, false, '没有活动挂载点时应返回 false');
  assert.equal(calls, 0, '已注销的回调不得再被调用');
});

test('P-5：未登记的插件返回 false（纯后台插件没有 UI 子树，不应报错）', () => {
  const registry = createSubtreeQuarantineRegistry();
  assert.equal(registry.quarantine('plugin.never-mounted', new Error('x')), false);
  assert.equal(registry.quarantine('', new Error('x')), false);
  assert.equal(registry.countOf('plugin.never-mounted'), 0);
});

test('P-5：单个隔离回调抛错不得中断其余回调（否则故障会级联）', () => {
  const registry = createSubtreeQuarantineRegistry();
  let secondCalled = false;

  registry.register('plugin.c', () => {
    throw new Error('隔离动作自身失败');
  });
  registry.register('plugin.c', () => {
    secondCalled = true;
  });

  assert.doesNotThrow(
    () => registry.quarantine('plugin.c', new Error('原始错误')),
    '隔离过程中的异常不得向外抛 —— 那会把一个插件的故障升级成宿主级异常级联',
  );
  assert.equal(secondCalled, true, '前一个回调抛错不得阻断后一个');
});

test('P-5：隔离回调内部注销自己时不得破坏遍历（遍历副本）', () => {
  const registry = createSubtreeQuarantineRegistry();
  const order: string[] = [];

  // 真实场景：隔离回调会 unmount 该挂载点，而 unmount 会调用注销函数
  let offFirst: () => void = () => {};
  offFirst = registry.register('plugin.d', () => {
    order.push('first');
    offFirst();
  });
  registry.register('plugin.d', () => {
    order.push('second');
  });

  assert.doesNotThrow(() => registry.quarantine('plugin.d', new Error('x')));
  assert.deepEqual(
    order,
    ['first', 'second'],
    '遍历必须在副本上进行，否则第一个回调注销自己会打乱迭代',
  );
  assert.equal(registry.countOf('plugin.d'), 1, '注销只影响自己那个挂载点');
});

test('P-5：非法入参静默忽略（空 pluginId / 非函数 handler）', () => {
  const registry = createSubtreeQuarantineRegistry();

  const offEmpty = registry.register('', () => {});
  const offBlank = registry.register('   ', () => {});
  const offBad = registry.register('plugin.e', undefined as unknown as () => void);

  assert.equal(registry.countOf('plugin.e'), 0, '非函数 handler 不得被登记');
  assert.doesNotThrow(() => {
    offEmpty();
    offBlank();
    offBad();
  }, '非法登记返回的注销函数必须可安全调用（调用方无需加分支）');
});
