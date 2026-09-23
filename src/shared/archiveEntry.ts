/**
 * 插件安装包 entry 名称安全校验（第一方实现，IMP-18）。
 *
 * 背景：`src/main/plugins.ts` 依赖 `node-stream-zip@1.16.0` 的
 * `ZipEntry.validateName()`（`node_stream_zip.js:900-904`）拦截逃逸型 entry 名。
 * 该防护经复现确认有效（见 `tests/plugin-package-extraction.test.ts`），但它属于**第三方实现**：
 * 依赖被降级、替换或误开 `skipEntryNameValidation` 都会静默失去防护。
 *
 * 因此这里把「什么算非法 entry 名」固化为第一方纯逻辑，供应用侧做第二道兜底。
 * 判定规则与上游保持一致（同一正则），并额外拒绝含 NUL 的名称
 * （NUL 会在落盘时抛错，属明确非法）。第一方判定**只可能更严，不会更松**。
 */

/** 与 node-stream-zip 的 validateName() 同一规则：反斜杠、盘符前缀、绝对路径、`..` 段。 */
const UNSAFE_ENTRY_NAME_PATTERN = /\\|^\w+:|^\/|(^|\/)\.\.(\/|$)/;

/** entry 名是否可安全解压到目标目录内。 */
export const isSafeArchiveEntryName = (name: unknown): boolean => {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name.includes('\u0000')) return false;
  return !UNSAFE_ENTRY_NAME_PATTERN.test(name);
};

/** 从一批 entry 名中挑出非法项（返回原始名称，便于写入错误信息）。 */
export const findUnsafeArchiveEntries = (names: unknown): string[] => {
  if (!Array.isArray(names)) return [];
  const unsafe: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (!isSafeArchiveEntryName(name)) unsafe.push(name);
  }
  return unsafe;
};
