import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

/**
 * 插件安装包解压的路径穿越（zip-slip）回归守卫。
 *
 * 背景（审计复核结论，2026-09-21）：
 *   审计报告曾判定 `src/main/plugins.ts` 的 `extractZipWithStreamZip()` 存在 zip-slip
 *   （IMP-02 / SEC-01），理由是「只校验 encrypted 与大小、不校验 entry 名称」。
 *   复核结论为**该判定不成立**：node-stream-zip@1.16.0 在读取中央目录时默认调用
 *   `ZipEntry.validateName()`（node_stream_zip.js:900-904），其正则
 *   `/\\|^\w+:|^\/|(^|\/)\.\.(\/|$)/` 会拒绝反斜杠、盘符前缀、绝对路径与 `..` 段；
 *   应用未设置 `skipEntryNameValidation`，因此该防护处于生效状态。
 *   实测（scripts/repro-zip-slip.cjs）所有逃逸变体均被 `Malicious entry` 拒绝。
 *
 * 本测试把上述「已核实为安全」的性质固化为回归守卫，防止以下退化：
 *   1. 依赖被降级 / 替换为不校验 entry 名的实现；
 *   2. 应用侧误加 `skipEntryNameValidation: true`；
 *   3. 解压目标目录被改成基于 entry 名拼接的其它路径。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ── 最小 ZIP 构造器（stored 方法，无第三方依赖）─────────────────────────────

const crc32 = (buffer: Buffer): number => {
  if (typeof (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32 === 'function') {
    return (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(buffer) >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

interface ZipEntrySpec {
  name: string;
  data?: string;
}

const buildZip = (entries: ZipEntrySpec[]): Buffer => {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    chunks.push(local, nameBytes, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
};

const withSandbox = async (run: (sandbox: string) => Promise<void>): Promise<void> => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'yanmusic-zipslip-test-'));
  try {
    await run(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

/** 与 src/main/plugins.ts:1834 同形的调用（不传 skipEntryNameValidation）。 */
const openLikeApp = (zipPath: string) => {
  const StreamZip = require('node-stream-zip');
  return new StreamZip.async({ file: zipPath });
};

// ── 测试 ────────────────────────────────────────────────────────────────────

test('逃逸型 entry 名被依赖拒绝（zip-slip 防护生效）', async () => {
  const escapeNames = [
    '../escaped.txt',
    '..\\escaped.txt',
    'foo/../../escaped.txt',
    '/abs/escaped.txt',
    'C:/escaped.txt',
    '..',
    'foo/..',
    'foo\\bar.txt',
  ];

  for (const name of escapeNames) {
    await withSandbox(async (sandbox) => {
      const zipPath = path.join(sandbox, 'evil.zip');
      writeFileSync(zipPath, buildZip([{ name, data: 'PWNED' }]));

      const zip = openLikeApp(zipPath);
      try {
        await assert.rejects(
          () => zip.entries(),
          /Malicious entry/,
          `entry 名 "${name}" 未被拒绝：依赖的 entry 名校验可能已失效`,
        );
      } finally {
        await zip.close().catch(() => {});
      }

      // 关键断言：解压目录之外不得出现任何文件
      const escaped = path.join(sandbox, 'escaped.txt');
      assert.equal(existsSync(escaped), false, `entry 名 "${name}" 逃出了解压目录`);
    });
  }
});

test('正常 entry 名可解压，且文件落在目标目录内', async () => {
  await withSandbox(async (sandbox) => {
    const extractDirectory = path.join(sandbox, 'extract');
    const zipPath = path.join(sandbox, 'ok.zip');
    writeFileSync(
      zipPath,
      buildZip([
        { name: 'plugin.json', data: '{"id":"demo"}' },
        { name: 'dist/index.js', data: 'export const x = 1;' },
      ]),
    );

    const zip = openLikeApp(zipPath);
    try {
      const entries = await zip.entries();
      assert.deepEqual(Object.keys(entries).sort(), ['dist/index.js', 'plugin.json']);
      await zip.extract(null, extractDirectory);
    } finally {
      await zip.close().catch(() => {});
    }

    assert.equal(readFileSync(path.join(extractDirectory, 'plugin.json'), 'utf8'), '{"id":"demo"}');
    assert.equal(
      readFileSync(path.join(extractDirectory, 'dist', 'index.js'), 'utf8'),
      'export const x = 1;',
    );
  });
});

test('应用侧未关闭依赖的 entry 名校验（防止 skipEntryNameValidation 退化）', () => {
  const pluginsSource = readFileSync(path.join(repoRoot, 'src', 'main', 'plugins.ts'), 'utf8');
  assert.equal(
    /skipEntryNameValidation/.test(pluginsSource),
    false,
    'src/main/plugins.ts 出现了 skipEntryNameValidation，会关闭 zip-slip 防护',
  );
  assert.ok(
    /new StreamZip\.async\(\{ file: zipPath \}\)/.test(pluginsSource),
    'StreamZip 构造方式已变化，请重新确认 entry 名校验仍然生效',
  );
});
