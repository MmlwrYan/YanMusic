import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Cargo workspace `resolver` 必须**显式声明**（V4-20，v1.4.0）。
 *
 * ## 为什么必须显式写
 *
 * 虚拟工作区（只有 `[workspace]`、没有 `[package]` 的根 `Cargo.toml`）**不会**
 * 从成员 crate 的 edition 推断 resolver —— 它默认用 **resolver 1**，
 * 并每次 `cargo check` 都打印一条警告：
 *
 * ```text
 * warning: virtual workspace defaulting to `resolver = "1"` despite one or more
 *          workspace members being on edition 2021 which implies `resolver = "2"`
 * ```
 *
 * 而本工作区四个成员**全是 edition 2021**（见各自的 `Cargo.toml`），
 * 也就是说 cargo 认定的解析行为与成员声明的 edition **不一致**。
 *
 * ## resolver 1 与 2 差在哪（为什么这不是「消警告」这么简单）
 *
 * 主要差别之一是 **feature 统一（feature unification）的范围**：
 * resolver 2 在「目标平台特定依赖」「构建依赖 / proc-macro」等场景下**不再**把
 * feature 跨这些边界合并。对本项目而言，四个 addon 共享同一个工作区、
 * 且都依赖 `napi` / `windows` 之类的平台特定 crate —— 解析器换了，
 * **实际链接进去的 feature 集合可能不同**。
 *
 * 因此本轮**不是加一行了事**：改完必须**重建全部四个 addon**并复验导出面
 * （已做：`31 / 28 / 11 / 4` 个导出，与改前一致）。
 *
 * ## 这条守卫守什么
 *
 * ① 根 `Cargo.toml` 必须显式写 `resolver = "2"`；
 * ② 它必须**真的等于 2**（写 `"1"` 也能消警告，但那会把 edition 2021 的语义
 *    强行退回 resolver 1 —— 与成员声明矛盾）；
 * ③ 每个 workspace 成员的 `edition` 都必须是 2021 或更新（否则 resolver 2 的
 *    前提不成立，本项的前提也就不成立）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

test('V4-20：根 Cargo.toml 必须显式声明 resolver = "2"', () => {
  const workspace = read('Cargo.toml');
  const match = workspace.match(/resolver\s*=\s*"([^"]+)"/);
  assert.ok(
    match,
    '根 Cargo.toml 必须显式写 `resolver` —— 虚拟工作区不会从成员 edition 推断，' +
      '不写就会默认 resolver 1 并每次 check 打印警告，且解析行为与成员声明的 edition 不一致',
  );
  assert.equal(
    match[1],
    '2',
    `resolver 应为 "2"（edition 2021 对应的语义）。当前是 "${match[1]}" —— ` +
      '写 "1" 同样能消掉那条警告，但那是把语义强行退回 resolver 1，' +
      '与四个成员声明的 edition 2021 相矛盾',
  );
  // 必须写在 [workspace] 段里（不是碰巧出现在别处）
  const workspaceSection = workspace.slice(workspace.indexOf('[workspace]'));
  assert.ok(
    workspaceSection.includes('resolver'),
    '`resolver` 必须位于 [workspace] 段内',
  );
});

test('V4-20：四个成员的 edition 都必须是 2021 或更新（resolver 2 的前提）', () => {
  const workspace = read('Cargo.toml');
  const members = [...workspace.matchAll(/"native\/([^"]+)"/g)].map((m) => m[1]);
  assert.equal(members.length, 4, `应有 4 个 native 成员，实际识别到 ${members.length} 个`);

  for (const member of members) {
    const crate = read(`native/${member}/Cargo.toml`);
    const edition = crate.match(/edition\s*=\s*"(\d+)"/);
    assert.ok(edition, `native/${member}/Cargo.toml 应声明 edition`);
    assert.ok(
      Number(edition[1]) >= 2021,
      `native/${member} 的 edition 是 ${edition[1]}，低于 2021 —— ` +
        '本项（显式 resolver = "2"）的前提因此不成立，需要重新评估',
    );
  }
});
