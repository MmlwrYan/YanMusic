import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NATIVE_ADDON_DIRS,
  checkNativeFreshness,
  describeCargoMirrorDiagnosis,
  findNewestSource,
  parseCargoSourceReplacement,
  toProbeUrl,
} from '../scripts/check-native-freshness.mjs';

/**
 * 原生产物新鲜度判据（V4-01，v1.4.0）。
 *
 * **它防什么（本机真实状态，2026-10-14 实测）**：
 *   `.node` 的 mtime = 2026-09-25，而它的 `.rs` 最新改动 = 2026-09-27 ——
 *   四个 addon **全部**如此。也就是说 `verify.ps1 -SkipNative` 报的「全绿」，
 *   是在**旧二进制**上取得的。这类假绿比失败更危险：它让人以为验证过了。
 *
 * **为什么用真实项目根也跑一条**：本项的价值就在于「当前仓库是否真的陈旧」，
 *   用临时目录无法证明这一点。但产物缺失是**正常状态**（干净检出 / CI 首次构建前），
 *   所以那条用例在缺失时 **skip 并标注未校验**，而不是失败。
 *
 * **怎样改会变红**：把 `checkNativeFreshness` 的 `stale` 判定改成恒 `false` →
 *   本文件的临时目录用例必须变红。
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

/** 造一个最小的 native 布局：<root>/native/<name>/{name}.node + src/x.rs */
const makeRoot = ({
  addon,
  binaryOffsetMs,
  sourceOffsetMs,
}: {
  addon: string;
  /** `null` = 不创建产物（模拟「干净检出」）；否则为相对「现在」的毫秒偏移。 */
  binaryOffsetMs: number | null;
  sourceOffsetMs: number;
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-fresh-'));
  const crateDir = path.join(root, 'native', addon);
  fs.mkdirSync(path.join(crateDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(crateDir, 'Cargo.toml'), '[package]\nname = "x"\n');
  const srcFile = path.join(crateDir, 'src', 'lib.rs');
  fs.writeFileSync(srcFile, '// x\n');

  const binaryPath = path.join(crateDir, `${addon}.node`);
  if (binaryOffsetMs !== null) {
    fs.writeFileSync(binaryPath, 'binary');
    const base = Date.now();
    fs.utimesSync(binaryPath, new Date(base + binaryOffsetMs), new Date(base + binaryOffsetMs));
    fs.utimesSync(srcFile, new Date(base + sourceOffsetMs), new Date(base + sourceOffsetMs));
  }
  return { root, crateDir, binaryPath, srcFile };
};

test('V4-01：产物比源码新 → 不算陈旧', () => {
  const { root } = makeRoot({ addon: 'yan-storage', binaryOffsetMs: 10_000, sourceOffsetMs: 0 });
  try {
    const result = checkNativeFreshness({ root, addonDirs: ['yan-storage'] });
    assert.equal(result.present, true);
    assert.equal(result.addons[0].stale, false);
    assert.equal(result.staleAddons.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：产物比源码旧 → 判为陈旧（本机真实形态）', () => {
  const { root } = makeRoot({ addon: 'yan-mpv-player', binaryOffsetMs: 0, sourceOffsetMs: 10_000 });
  try {
    const result = checkNativeFreshness({ root, addonDirs: ['yan-mpv-player'] });
    assert.equal(result.addons[0].stale, true, '源码更新时必须判为陈旧');
    assert.equal(result.staleAddons.length, 1);
    assert.ok(
      result.addons[0].newestSourcePath.endsWith('lib.rs'),
      '应报出**最新的那个**源文件路径，便于定位',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：产物缺失 → present=false 且标 missing（用于 skip 并标注未校验）', () => {
  const { root } = makeRoot({ addon: 'yan-storage', binaryOffsetMs: null, sourceOffsetMs: 0 });
  try {
    const result = checkNativeFreshness({ root, addonDirs: ['yan-storage'] });
    assert.equal(result.present, false, '无任何产物时 present 必须为 false');
    assert.equal(result.addons[0].missing, true);
    assert.equal(result.addons[0].stale, false, '产物缺失不应被算作「陈旧」——两者语义不同');
    assert.equal(result.staleAddons.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：部分缺失时 present=true，且只对存在的那部分判陈旧', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-mixed-'));
  try {
    const base = Date.now();
    // A：有产物且不旧；B：有产物但旧
    const cases: [string, number][] = [
      ['yan-storage', 10_000],
      ['yan-mpv-player', -10_000],
    ];
    for (const [name, off] of cases) {
      const crateDir = path.join(root, 'native', name);
      fs.mkdirSync(path.join(crateDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(crateDir, 'src', 'lib.rs'), '// x\n');
      fs.writeFileSync(path.join(crateDir, `${name}.node`), 'bin');
      fs.utimesSync(
        path.join(crateDir, `${name}.node`),
        new Date(base + off),
        new Date(base + off),
      );
      fs.utimesSync(path.join(crateDir, 'src', 'lib.rs'), new Date(base), new Date(base));
    }
    // C：无产物
    fs.mkdirSync(path.join(root, 'native', 'yan-media-controls', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'native', 'yan-media-controls', 'src', 'lib.rs'), '// x\n');

    const result = checkNativeFreshness({
      root,
      addonDirs: ['yan-storage', 'yan-mpv-player', 'yan-media-controls'],
    });
    assert.equal(result.present, true);
    assert.deepEqual(
      result.staleAddons.map((x) => x.name),
      ['yan-mpv-player'],
    );
    assert.deepEqual(
      result.missingAddons.map((x) => x.name),
      ['yan-media-controls'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：crate 目录不存在时不抛错（干净检出 / 目录改名都不得让验证脚本崩）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-none-'));
  try {
    const result = checkNativeFreshness({ root, addonDirs: ['yan-not-exist'] });
    assert.equal(result.present, false);
    assert.equal(result.addons[0].stale, false);
    assert.equal(findNewestSource(path.join(root, 'native', 'yan-not-exist')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：扫描时跳过 target/ 与 node_modules/（否则会白扫几万文件）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-skip-'));
  try {
    const crateDir = path.join(root, 'native', 'yan-storage');
    fs.mkdirSync(path.join(crateDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(crateDir, 'src', 'lib.rs'), '// src\n');
    // 这两个目录里的「更新的文件」不得影响结论
    for (const skip of ['target', 'node_modules']) {
      fs.mkdirSync(path.join(crateDir, skip, 'deep'), { recursive: true });
      const f = path.join(crateDir, skip, 'deep', 'generated.rs');
      fs.writeFileSync(f, '// generated\n');
      const future = Date.now() + 86_400_000;
      fs.utimesSync(f, new Date(future), new Date(future));
    }
    const newest = findNewestSource(crateDir);
    assert.ok(newest, '应找到 src/lib.rs');
    assert.ok(
      !newest.path.includes('target') && !newest.path.includes('node_modules'),
      'target/ 与 node_modules/ 里的文件必须被跳过',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V4-01：对**真实仓库**执行 —— 产物缺失时 skip 并显式标注未校验', (t) => {
  const result = checkNativeFreshness({ root: repoRoot });
  if (!result.present) {
    t.skip(
      '四个 .node 均不存在（干净检出 / 尚未构建）—— 本项**未校验**，不代表通过；' +
        '构建后可由 `node scripts/check-native-freshness.mjs` 复核',
    );
    return;
  }
  assert.deepEqual(
    result.staleAddons.map((x) => x.name),
    [],
    '原生产物比源码旧 —— 在旧二进制上取得的「绿」不算验证，请重建 addon 后再取证',
  );
});

test('V4-01：addon 清单与 Cargo workspace members 一致（防漏检查某个 crate）', () => {
  const workspace = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8');
  for (const dir of NATIVE_ADDON_DIRS) {
    assert.ok(
      workspace.includes(`native/${dir}`),
      `${dir} 必须在 Cargo.toml 的 workspace members 里 —— 否则清单与工程结构漂移`,
    );
  }
  // 反向：workspace 里的 native 成员都要被检查到
  const members = [...workspace.matchAll(/"(native\/[^"]+)"/g)].map((m) => m[1].split('/')[1]);
  assert.deepEqual(
    [...members].sort(),
    [...NATIVE_ADDON_DIRS].sort(),
    'NATIVE_ADDON_DIRS 必须覆盖 workspace 里的全部 native 成员',
  );
});

test('V4-01：cargo 镜像解析 —— 取出 replace-with 指向的 registry', () => {
  const config = [
    '[source.crates-io]',
    'replace-with = "ustc"',
    '',
    '[source.ustc]',
    'registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"',
    '',
    '[source.mygetorg]',
    'registry = "sparse+https://npm.myget.org/f/nuget-community/public/npm/"',
  ].join('\n');

  const parsed = parseCargoSourceReplacement(config);
  assert.deepEqual(parsed, {
    alias: 'ustc',
    registry: 'sparse+https://mirrors.ustc.edu.cn/crates.io-index/',
  });
  // 必须取到**替换目标**那个 block 的 registry，不能误取同文件里其它 source
  assert.ok(!parsed.registry.includes('myget'), '不得误取其它 [source.*] 的 registry');
});

test('V4-01：cargo 镜像解析 —— 无 replace-with / 缺 registry / 空输入都要能处理', () => {
  assert.equal(parseCargoSourceReplacement(''), null);
  assert.equal(parseCargoSourceReplacement('[source.crates-io]\n'), null);
  assert.equal(parseCargoSourceReplacement('[build]\ntarget-dir = "x"\n'), null);
  const noRegistry = parseCargoSourceReplacement(
    '[source.crates-io]\nreplace-with = "tuna"\n\n[source.tuna]\n',
  );
  assert.deepEqual(noRegistry, { alias: 'tuna', registry: '' });
});

test('V4-01：探测 URL 由 registry 正确构造（去掉 sparse+ 前缀、补 config.json）', () => {
  assert.equal(
    toProbeUrl('sparse+https://mirrors.ustc.edu.cn/crates.io-index/'),
    'https://mirrors.ustc.edu.cn/crates.io-index/config.json',
  );
  // 无尾斜杠也要正确
  assert.equal(
    toProbeUrl('sparse+https://mirrors.ustc.edu.cn/crates.io-index'),
    'https://mirrors.ustc.edu.cn/crates.io-index/config.json',
  );
  assert.equal(toProbeUrl(''), '');
  assert.equal(toProbeUrl('not a url'), '');
});

/**
 * 诊断文案的核心要求：**必须点明根因是镜像**。
 *
 * 这条断言直接来自真实代价：历史上同一故障被写成「代理 502」，
 * 于是没人去查镜像，N 组技术债白挂了两周。
 */
test('V4-01：镜像诊断文案必须点明「不是代理问题」并给出可执行解法', () => {
  const text = describeCargoMirrorDiagnosis({
    alias: 'tuna',
    registry: 'sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/',
    probeUrl: 'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/config.json',
    reason: 'fetch failed',
  });
  assert.ok(text.includes('tuna'), '必须点出具体的镜像别名');
  assert.ok(text.includes('mirrors.tuna.tsinghua.edu.cn'), '必须点出镜像地址');
  assert.ok(text.includes('fetch failed'), '必须带上实际错误原文，便于二次判断');
  assert.ok(text.includes('不是「代理 502」'), '必须显式切断「这是代理问题」的旧误判');
  assert.ok(text.includes('config.toml'), '必须告知改哪个文件');
  assert.ok(text.includes('备份'), '改全局配置前必须提醒备份');
});
