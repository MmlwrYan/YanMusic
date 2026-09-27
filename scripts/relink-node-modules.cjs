#!/usr/bin/env node
/**
 * relink-node-modules.cjs
 *
 * 背景（2026-09-27）：
 *   本机沙箱环境下 pnpm 的「链接阶段（linking）」被静默阻断——它能在
 *   node_modules/.pnpm 下创建 500+ 个包目录，却几乎不创建任何 symlink /
 *   junction（2200+ 目录里只有 1 个链接）。结果是 `vue-tsc`、`vite` 等
 *   命令全部报 MODULE_NOT_FOUND。手动 `fs.symlinkSync(..., 'junction')`
 *   完全正常，说明只是 pnpm 自身的写操作被拦。
 *
 * 本脚本的职责：
 *   依据 pnpm 自己已经算好的 `node_modules/.package-map.json`
 *   （key = 包标识，value.url = 该包在虚拟store中的实体路径，
 *    value.dependencies = 它依赖的包 → 依赖包的包标识），
 *   把缺失的链接全部补齐：
 *     1) 每个包目录内的依赖链接：
 *        <pkgDir>/node_modules/<depName>  ->  <depPkgDir>
 *     2) 顶层公共提升（hoistPattern = ["*"]）：
 *        node_modules/<depName>           ->  <depPkgDir>
 *   以及 node_modules/.bin 下的可执行 shim 链接。
 *
 * 幂等：已存在且指向正确的链接会被跳过。
 *
 * 用法：
 *   node scripts/relink-node-modules.cjs            # 修复链接
 *   node scripts/relink-node-modules.cjs --check    # 只检查，不写入
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const MAP_FILE = path.join(NM, '.package-map.json');
// 注意：package-map 里的 entry.url 是相对于 **node_modules/** 的
// （根包 "." 的 url 是 ".."，即 node_modules 的上一级 = 项目根）。
// 所以基准目录必须是 NM，不是 ROOT。
const URL_BASE = NM;
const CHECK_ONLY = process.argv.includes('--check');

function log(...a) {
  if (!CHECK_ONLY) console.log(...a);
}

/** 读取 pnpm 的 package-map（不存在则报错退出） */
function loadPackageMap() {
  if (!fs.existsSync(MAP_FILE)) {
    console.error(`[relink] 找不到 ${MAP_FILE}`);
    console.error('[relink] 请先执行一次 `pnpm install` 以生成该文件。');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  return raw.packages || {};
}

/**
 * 把 pnpm 的包标识（可能含 peer 后缀，如
 *   @iconify/vue@5.0.3(vue@3.5.43(typescript@5.9.3))）
 * 规范化成用于查找的 key 候选列表。
 * package-map 的 key 与 dependencies 的 value 是同一种格式，直接查即可。
 */
function resolveEntry(packages, key) {
  return packages[key] || null;
}

/** 由实体路径推出「包名」——用于决定链接放置位置 */
function packageNameOf(entry) {
  // entry.dependencies 里恰好有一条形如 name -> key，取它最稳
  if (entry && entry.dependencies) {
    const names = Object.keys(entry.dependencies);
    if (names.length === 1) return names[0];
  }
  return null;
}

let created = 0;
let ok = 0;
let failed = 0;
let skipped = 0;

/** 建立/校验一个 junction 链接（targetPath / linkPath 均为相对 URL_BASE 的路径） */
function ensureLink(targetPath, linkPath, label, base) {
  const absTarget = path.resolve(base || URL_BASE, targetPath);
  const absLink = path.resolve(base || URL_BASE, linkPath);

  if (!fs.existsSync(absTarget)) {
    console.warn(`[relink] 目标不存在，跳过：${label} -> ${targetPath}`);
    skipped++;
    return;
  }

  let existing = null;
  try {
    const st = fs.lstatSync(absLink);
    if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
      existing = fs.realpathSync(absLink);
    }
  } catch {
    /* 不存在 */
  }

  if (existing) {
    // 已存在：判断是否指向正确目标（realpath 对比）
    let want = absTarget;
    try {
      want = fs.realpathSync(absTarget);
    } catch {
      /* ignore */
    }
    if (existing === want) {
      ok++;
      return;
    }
    // 指向错误 -> 删掉重建
    if (CHECK_ONLY) {
      console.log(`[relink][check] 链接错误：${label} -> ${existing}（应为 ${want}）`);
      failed++;
      return;
    }
    try {
      fs.rmSync(absLink, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[relink] 无法删除错误链接 ${label}: ${e.message}`);
      failed++;
      return;
    }
  }

  if (CHECK_ONLY) {
    console.log(`[relink][check] 缺失：${label} -> ${targetPath}`);
    failed++;
    return;
  }

  try {
    fs.mkdirSync(path.dirname(absLink), { recursive: true });
    fs.symlinkSync(absTarget, absLink, 'junction');
    created++;
  } catch (e) {
    console.warn(`[relink] 建立链接失败 ${label}: ${e.code} ${e.message}`);
    failed++;
  }
}

function main() {
  const packages = loadPackageMap();
  const entries = Object.entries(packages);
  log(`[relink] package-map 条目数：${entries.length}`);

  // 预扫：包标识 -> 实体目录（绝对）
  const dirOf = new Map();
  for (const [key, entry] of entries) {
    if (!entry || !entry.url) continue;
    dirOf.set(key, path.resolve(URL_BASE, entry.url));
  }

  // 1) 每个包目录内的依赖链接
  for (const [key, entry] of entries) {
    if (!entry || !entry.url || !entry.dependencies) continue;
    const pkgDirAbs = path.resolve(URL_BASE, entry.url);
    for (const [depName, depKey] of Object.entries(entry.dependencies)) {
      // 自身链接（包实体路径即自身）跳过
      const depDirAbs = dirOf.get(depKey);
      if (!depDirAbs) {
        skipped++;
        continue;
      }
      const linkAbs = path.join(pkgDirAbs, 'node_modules', depName);
      // 已经是同一个目录（depName 视角就是自己）——跳过
      if (path.resolve(linkAbs) === path.resolve(depDirAbs)) {
        skipped++;
        continue;
      }
      // 相对基准的写法交给 ensureLink
      ensureLink(path.relative(URL_BASE, depDirAbs), path.relative(URL_BASE, linkAbs), `${key}::${depName}`);
    }
  }

  // 2) 顶层提升：node_modules/<name> -> 该 name 唯一/最佳实体
  //    pnpm 的规则：优先选择「被最多包依赖」的版本；这里用 package-map
  //    里该包名下第一个出现的条目作为候选（顺序即 pnpm 的解析顺序）。
  const byName = new Map(); // name -> {key, count}
  for (const [key, entry] of entries) {
    if (!entry || !entry.dependencies) continue;
    const names = Object.keys(entry.dependencies);
    for (const n of names) {
      const cur = byName.get(n) || { key: entry.dependencies[n], count: 0 };
      cur.count++;
      // 保留 package-map 中出现顺序靠前者
      byName.set(n, cur);
    }
  }

  for (const [name, info] of byName) {
    // 根包的 dependencies 已由 pnpm 正确直连（其 url=".."），跳过 "." 条目
    const dirAbs = dirOf.get(info.key);
    if (!dirAbs) {
      skipped++;
      continue;
    }
    const linkAbs = path.join(NM, name);
    ensureLink(path.relative(URL_BASE, dirAbs), path.relative(URL_BASE, linkAbs), `hoist:${name}`);
  }

  // 3) .bin shims —— 依据各包 package.json 的 bin 字段
  const binDir = path.join(NM, '.bin');
  if (!CHECK_ONLY) fs.mkdirSync(binDir, { recursive: true });

  for (const [key, entry] of entries) {
    if (!entry || !entry.url) continue;
    const pkgDirAbs = path.resolve(URL_BASE, entry.url);
    const pj = path.join(pkgDirAbs, 'package.json');
    if (!fs.existsSync(pj)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    } catch {
      continue;
    }
    if (!meta.bin) continue;
    const bins =
      typeof meta.bin === 'string' ? { [meta.name.replace(/^@.*\//, '')]: meta.bin } : meta.bin;
    for (const [binName, relFromPkg] of Object.entries(bins || {})) {
      const targetAbs = path.resolve(pkgDirAbs, relFromPkg);
      if (!fs.existsSync(targetAbs)) continue;
      const binLinkAbs = path.join(binDir, binName);
      if (fs.existsSync(binLinkAbs)) {
        ok++;
        continue;
      }
      if (CHECK_ONLY) {
        failed++;
        continue;
      }
      try {
        fs.symlinkSync(targetAbs, binLinkAbs, 'file');
        created++;
      } catch {
        // Windows 上 .bin 通常是 cmd shim，缺了也不致命
        skipped++;
      }
    }
  }

  console.log(
    `[relink] 完成：新建 ${created}，已正确 ${ok}，跳过 ${skipped}，失败/缺失 ${failed}`
  );
  if (CHECK_ONLY && failed > 0) process.exit(1);
}

main();
