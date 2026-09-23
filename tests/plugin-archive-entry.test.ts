import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { findUnsafeArchiveEntries, isSafeArchiveEntryName } from '../src/shared/archiveEntry.ts';

/**
 * IMP-18：插件包解压路径校验的纯函数单测。
 *
 * 两层断言：
 *   1. 第一方校验器 `isSafeArchiveEntryName` 自身行为正确；
 *   2. **与依赖库的真实判定交叉验证**：用真实 zip 让 `node-stream-zip` 判定每个名称，
 *      断言「库拒绝的，第一方也拒绝」（第一方允许更严，但绝不允许更松）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ESCAPE_NAMES = [
  '../escaped.txt',
  '..\\escaped.txt',
  'foo/../../escaped.txt',
  '/abs/escaped.txt',
  'C:/escaped.txt',
  '..',
  'foo/..',
  'foo\\bar.txt',
];

const BENIGN_NAMES = [
  'plugin.json',
  'dist/index.js',
  'a/b/c/d.txt',
  '%2e%2e/encoded.txt',
  '含 空格.txt',
];

// ── 最小 ZIP 构造器（stored，用于让真实库判定 entry 名）────────────────────

const crc32 = (buffer: Buffer): number => {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const buildZip = (name: string): Buffer => {
  const nameBytes = Buffer.from(name, 'utf8');
  const data = Buffer.from('x', 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBody = Buffer.concat([central, nameBytes]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + data.length, 16);

  return Buffer.concat([local, nameBytes, data, centralBody, end]);
};

/** 用真实 node-stream-zip 判定该名称是否被拒绝。 */
const libraryRejects = async (name: string): Promise<boolean> => {
  const StreamZip = require('node-stream-zip');
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'entry-name-'));
  const zipPath = path.join(sandbox, 'probe.zip');
  writeFileSync(zipPath, buildZip(name));
  const zip = new StreamZip.async({ file: zipPath });
  try {
    await zip.entries();
    return false;
  } catch (error) {
    return /Malicious entry/.test(String((error as Error).message));
  } finally {
    await zip.close().catch(() => {});
    rmSync(sandbox, { recursive: true, force: true });
  }
};

// ── 用例 ────────────────────────────────────────────────────────────────────

test('isSafeArchiveEntryName：拒绝全部逃逸型名称', () => {
  for (const name of ESCAPE_NAMES) {
    assert.equal(isSafeArchiveEntryName(name), false, `应拒绝：${name}`);
  }
});

test('isSafeArchiveEntryName：放行常规包内路径', () => {
  for (const name of BENIGN_NAMES) {
    assert.equal(isSafeArchiveEntryName(name), true, `应放行：${name}`);
  }
});

test('isSafeArchiveEntryName：非字符串与空值一律拒绝', () => {
  for (const value of [null, undefined, 42, {}, [], '', true]) {
    assert.equal(isSafeArchiveEntryName(value), false, `应拒绝：${JSON.stringify(value)}`);
  }
});

test('isSafeArchiveEntryName：额外拒绝含 NUL 的名称（比依赖更严）', () => {
  assert.equal(isSafeArchiveEntryName('a\u0000b.txt'), false);
});

test('与 node-stream-zip 真实判定交叉验证：库拒绝的，第一方也必须拒绝', async () => {
  for (const name of ESCAPE_NAMES) {
    const rejected = await libraryRejects(name);
    assert.equal(rejected, true, `前置假设失败：库未拒绝 ${name}（依赖行为已变，需重新评估）`);
    assert.equal(isSafeArchiveEntryName(name), false, `第一方漏放：${name}`);
  }
});

test('与 node-stream-zip 真实判定交叉验证：常规路径库与第一方都不拒绝', async () => {
  for (const name of BENIGN_NAMES) {
    const rejected = await libraryRejects(name);
    assert.equal(rejected, false, `常规路径被库拒绝（${name}），用例前提需复核`);
    assert.equal(isSafeArchiveEntryName(name), true, `第一方误拒：${name}`);
  }
});

test('findUnsafeArchiveEntries：挑出非法项并跳过非字符串', () => {
  assert.deepEqual(findUnsafeArchiveEntries(['ok/a.txt', '../bad', 'ok/b.txt', '/abs']), [
    '../bad',
    '/abs',
  ]);
  assert.deepEqual(findUnsafeArchiveEntries(['ok/a.txt', 42, null, 'ok/b.txt']), []);
  assert.deepEqual(findUnsafeArchiveEntries('not-an-array'), []);
  assert.deepEqual(findUnsafeArchiveEntries([]), []);
});

test('应用侧已接入第一方兜底校验（防止依赖被替换后静默失去防护）', () => {
  const pluginsSource = readFileSync(path.join(repoRoot, 'src', 'main', 'plugins.ts'), 'utf8');
  assert.ok(
    pluginsSource.includes('findUnsafeArchiveEntries'),
    'src/main/plugins.ts 未接入第一方 entry 名校验',
  );
  assert.ok(existsSync(path.join(repoRoot, 'src', 'shared', 'archiveEntry.ts')));
});
