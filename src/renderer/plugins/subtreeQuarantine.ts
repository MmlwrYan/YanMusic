/**
 * P-5（v1.3.0）：插件 UI 子树的**隔离注册表**。
 *
 * ## 问题
 *
 * 插件与宿主**同 realm、同事件循环**（H-1 的结论）。因此一个写坏的插件组件
 * （渲染中抛错、在 `setup()` 里访问 undefined 等）出错时：
 *
 * - Vue 的 `errorHandler` 会被调用，此前的实现只做**记录 + 上报**；
 * - **出错的组件树仍留在页面上** —— 可能是半渲染状态，并在后续更新中反复抛错，
 *   把宿主的控制台/上报通道刷满，用户看到的是「页面某块坏了但没有任何说明」。
 *
 * 规划 §2.2 P-5 的要求：**至少做到「插件 UI 子树出错只卸载该子树 + 明确提示」**。
 *
 * ## 边界（本模块**不做**的事）
 *
 * 死循环 / 长任务类故障**无法在 JS 层防**（同 realm 同事件循环，主线程被占满时
 * 任何 JS 兜底都跑不起来）。那一类靠 P-1 收窄具名 API 的破坏面 + 记录为残余风险，
 * 真正的进程级隔离留给 v1.4.0。本模块只负责「**已经抛出来的错误**之后，把坏掉的那块
 * 摘掉并告知用户」，不让它继续污染宿主。
 *
 * ## 为什么单独成模块
 *
 * 本模块**零依赖**（无 Vue、无 DOM），因此可在 `node --test` 下**直接驱动真行为** ——
 * 而 `renderer/plugins/runtime.ts`（import Vue）不行。DOM 渲染部分留在 runtime.ts，
 * 并与本模块**分离**：本模块只决定「要隔离谁」，怎么画占位由调用方决定。
 */

/** 隔离回调：由挂载方提供，负责卸载该子树并在原位给出提示。 */
export type SubtreeQuarantineHandler = (error: unknown, info?: string) => void;

export interface SubtreeQuarantineRegistry {
  /**
   * 登记一个挂载点的隔离回调（同一插件可有多个挂载点）。
   * @returns 注销函数（挂载点正常卸载时调用）
   */
  register(pluginId: string, handler: SubtreeQuarantineHandler): () => void;
  /**
   * 隔离某插件的**全部**已登记挂载点。
   * @returns 是否至少处理了一个挂载点（`false` = 该插件当前没有活动的 UI 挂载点）
   */
  quarantine(pluginId: string, error: unknown, info?: string): boolean;
  /** 该插件当前登记的挂载点数量（诊断/测试用）。 */
  countOf(pluginId: string): number;
}

export const createSubtreeQuarantineRegistry = (): SubtreeQuarantineRegistry => {
  const handlers = new Map<string, Set<SubtreeQuarantineHandler>>();

  const register = (pluginId: string, handler: SubtreeQuarantineHandler): (() => void) => {
    const key = String(pluginId ?? '').trim();
    // 非法入参静默忽略，并返回空注销函数 —— 调用方无需为此加分支
    if (!key || typeof handler !== 'function') return () => {};

    let set = handlers.get(key);
    if (!set) {
      set = new Set();
      handlers.set(key, set);
    }
    set.add(handler);

    return () => {
      const current = handlers.get(key);
      if (!current) return;
      current.delete(handler);
      // 空集合要删掉，否则长跑（反复挂载/卸载插件）会让 Map 无限增长
      if (current.size === 0) handlers.delete(key);
    };
  };

  const quarantine = (pluginId: string, error: unknown, info?: string): boolean => {
    const key = String(pluginId ?? '').trim();
    if (!key) return false;
    const set = handlers.get(key);
    if (!set || set.size === 0) return false;

    // 遍历副本：handler 内部会调用注销函数（卸载挂载点时注销自己），
    // 直接遍历原集合会在迭代中修改它。
    for (const handler of [...set]) {
      try {
        handler(error, info);
      } catch {
        // 隔离动作本身失败**不得**向外抛：否则会在错误处理路径里制造新错误，
        // 把一个插件的故障升级成宿主级的异常级联（那正是 P-5 要防的事）。
        // 也刻意不在此处再上报：上报通道可能正因同一插件而异常。
      }
    }
    return true;
  };

  const countOf = (pluginId: string): number =>
    handlers.get(String(pluginId ?? '').trim())?.size ?? 0;

  return { register, quarantine, countOf };
};
