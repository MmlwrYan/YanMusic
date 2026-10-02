import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import StreamZip from 'node-stream-zip';

import { buildZipBuffer, crc32 } from '../src/main/diagnostics/zipWriter.ts';

/**
 * S-6（v1.3.0）守卫：自实现 ZIP 写入器的**往返验证**。
 *
 * ## 为什么是往返验证
 *
 * 项目里只有 `node-stream-zip`（**读取**库），没有写入库 —— 诊断包要「打包成 zip
 * 供用户发给维护者」，故写入能力是自实现的。
 *
 * 自实现二进制格式最怕「写完不知道对不对」。这类实现**不能只靠单测断言自己的输出**
 *（那等于用同一套错误假设去验证自己），必须用**独立的读取器**把结果读回来比对。
 * 本文件用 `node-stream-zip` 充当那个独立读取器 —— 它若能把我们生成的文件
 * 正确解出文件名与内容，就说明中央目录、本地头、CRC、压缩方法、UTF-8 标志都对。
 *
 * 仓库里插件包解压走的正是 `node-stream-zip`，所以这个读取器也是**真实消费方**，
 * 不是为测试造的工具。
 *
 * ⚠️ 鉴别力验证（本文件必须能红）：
 *  把 `buildZipBuffer` 里写中央目录的 `entry.localHeaderOffset` 改成 0 → 用例 1 变红
 *（读取器会报无法定位条目数据）。
 */

const withTempDir = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yanmusic-zip-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 用独立读取器（node-stream-zip）把 buffer 读回成 { name: content }。 */
const readBack = async (buffer: Buffer): Promise<Record<string, Buffer>> =>
  withTempDir(async (dir) => {
    const zipPath = path.join(dir, 'bundle.zip');
    writeFileSync(zipPath, buffer);

    const zip = new StreamZip.async({ file: zipPath });
    try {
      const entries = await zip.entries();
      const result: Record<string, Buffer> = {};
      for (const name of Object.keys(entries)) {
        if (entries[name].isDirectory) continue;
        result[name] = await zip.entryData(name);
      }
      return result;
    } finally {
      await zip.close();
    }
  });

test('S-6：crc32 与标准测试向量一致', () => {
  // 这是 CRC-32/ISO-HDLC 的标准测试向量，用来确认多项式与初值/终值处理正确
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
});

test('S-6：生成的 zip 能被独立读取器完整读回（内容逐一一致）', async () => {
  const textContent = '第一行日志\n第二行日志\n';
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x7f]);
  const bigText = 'A'.repeat(50_000); // 足够大，会被 deflate 命中

  const buffer = buildZipBuffer(
    [
      { name: 'diagnostics.json', data: '{"version":"1.3.0"}' },
      { name: 'logs/yan-music-2026-10-02.log', data: textContent },
      { name: '设置摘要.json', data: '{"theme":"dark"}' }, // 中文名 → UTF-8 标志
      { name: 'empty.txt', data: '' }, // 空文件
      { name: 'binary.bin', data: binary }, // 几乎不可压缩
      { name: 'big.txt', data: bigText },
    ],
    new Date('2026-10-02T12:00:00'),
  );

  const readBackEntries = await readBack(buffer);

  assert.deepEqual(
    Object.keys(readBackEntries).sort(),
    [
      'big.txt',
      'binary.bin',
      'diagnostics.json',
      'empty.txt',
      'logs/yan-music-2026-10-02.log',
      '设置摘要.json',
    ].sort(),
    '文件名（含中文与带目录的路径）必须被读取器正确解出',
  );

  assert.equal(readBackEntries['diagnostics.json'].toString('utf8'), '{"version":"1.3.0"}');
  assert.equal(readBackEntries['logs/yan-music-2026-10-02.log'].toString('utf8'), textContent);
  assert.equal(
    readBackEntries['设置摘要.json'].toString('utf8'),
    '{"theme":"dark"}',
    '中文文件名必须能正确往返（UTF-8 标志）',
  );
  assert.equal(readBackEntries['empty.txt'].length, 0, '空文件必须能往返');
  assert.deepEqual(readBackEntries['binary.bin'], binary, '二进制内容必须逐字节一致');
  assert.equal(
    readBackEntries['big.txt'].toString('utf8'),
    bigText,
    '大文本（deflate）必须往返一致',
  );
});

test('S-6：压缩方式按「更小者」选择，且读取器不关心用了哪种', async () => {
  // 高度可压缩的文本应当被 deflate（生成结果显著小于原始内容）
  const compressible = 'x'.repeat(20_000);
  const onlyCompressible = buildZipBuffer([{ name: 'c.txt', data: compressible }]);
  assert.ok(
    onlyCompressible.length < compressible.length / 2,
    '可压缩文本应被 deflate（否则诊断包会无谓地大）',
  );

  // 随机二进制不可压缩：应回退为 store，且代价只是几字节头部
  const incompressible = Buffer.alloc(4096);
  for (let i = 0; i < incompressible.length; i++) incompressible[i] = (i * 37 + 11) & 0xff;
  const stored = buildZipBuffer([{ name: 'b.bin', data: incompressible }]);
  assert.ok(
    stored.length < incompressible.length + 200,
    '不可压缩数据不得因强行 deflate 而膨胀（应回退 store）',
  );

  const [a, b] = await Promise.all([readBack(onlyCompressible), readBack(stored)]);
  assert.equal(a['c.txt'].toString('utf8'), compressible);
  assert.deepEqual(b['b.bin'], incompressible);
});

test('S-6：空包也是合法 zip（读取器不报错、条目为空）', async () => {
  const buffer = buildZipBuffer([]);
  const entries = await readBack(buffer);
  assert.deepEqual(entries, {}, '空包应能被正常解析且无条目');
});

test('S-6：拒绝超出 zip64 上限的条目（明确报错而非静默产出坏包）', () => {
  // 只验证「名字过长」这一可廉价触发的守卫分支；
  // 4GB 条目无法在测试里构造，但同一处校验逻辑已在实现中显式写明不支持 zip64。
  const longName = `${'a'.repeat(70_000)}.log`;
  assert.throws(
    () => buildZipBuffer([{ name: longName, data: 'x' }]),
    /过长/,
    '超长文件名必须明确报错（ZIP 名字长度字段是 16 位）',
  );
});
