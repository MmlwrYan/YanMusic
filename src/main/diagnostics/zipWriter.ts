import { deflateRawSync } from 'node:zlib';

/**
 * S-6（v1.3.0）：ZIP 写入器（**自实现**，零第三方依赖）。
 *
 * ## 为什么自己写
 *
 * 项目里只有 `node-stream-zip` —— 它是**读取**库，不能写。而诊断包要「打包成 zip
 * 供用户直接发给维护者」，故需要写入能力。
 *
 * 不用第三方写入库的理由：诊断包是**用户主动导出**的功能，引入新的运行时依赖
 * （以及随之而来的供应链面）不值得 —— ZIP 的 store/deflate 子集实现约百行即可，
 * 且能用已有的 `node-stream-zip` **读回验证**（往返测试），所以它是**可验证的**，
 * 不是「写完就祈祷」。
 *
 * ## 实现范围（刻意最小）
 *
 * - 支持 **deflate（8）与 store（0）** 两种方式；每个条目取更小者
 * - 文件名标记 **UTF-8（flag 0x0800）** —— 诊断包内会有中文文件名（如「设置摘要.json」）
 * - **不**支持：目录条目（用 `/` 结尾的名字隐含）、zip64（诊断包远小于 4GB）、
 *   加密、data descriptor、额外字段
 *
 * ## 可验证性
 *
 * `tests/diagnostics-zip.test.ts` 用 `node-stream-zip` 把生成的 buffer **读回**，
 * 断言文件名与内容逐一一致，并覆盖中文名、空文件、二进制数据等边界。
 */

export interface ZipEntryInput {
  /** 包内路径（用 `/` 分隔）。以 `/` 结尾表示目录。 */
  name: string;
  data: Buffer | string;
}

/** ZIP 单个条目在 4GB 以内的上限（超出即不支持 —— 诊断包不会到那个量级）。 */
const MAX_ENTRY_BYTES = 0xffffffff;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** 把 Date 转成 ZIP 需要的 DOS 时间/日期（1980 起算，秒精度为 2 秒）。 */
const toDosDateTime = (date: Date): { time: number; date: number } => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

interface PreparedEntry {
  nameBuffer: Buffer;
  raw: Buffer;
  /** 实际写入的字节（store 时等于 raw，deflate 时是压缩结果） */
  payload: Buffer;
  method: 0 | 8;
  crc: number;
  localHeaderOffset: number;
}

/** 全部小端写整数（ZIP 是小端格式）。 */
const writeUInt16 = (target: Buffer, offset: number, value: number) =>
  target.writeUInt16LE(value & 0xffff, offset);
const writeUInt32 = (target: Buffer, offset: number, value: number) =>
  target.writeUInt32LE(value >>> 0, offset);

/**
 * 生成 zip 的完整字节。
 *
 * @param entries 包内条目（顺序即写入顺序）
 * @param now 用于 DOS 时间戳（注入以便测试可复现）
 */
export const buildZipBuffer = (entries: ZipEntryInput[], now: Date = new Date()): Buffer => {
  const { time, date } = toDosDateTime(now);
  const prepared: PreparedEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    if (raw.length > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP 条目过大（不支持 zip64）：${entry.name}`);
    }

    // 目录条目：名字以 / 结尾且无内容
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    if (nameBuffer.length > 0xffff) {
      throw new Error(`ZIP 条目名过长：${entry.name}`);
    }

    const crc = crc32(raw);
    // 只有在确实更小的时候才用 deflate —— 已压缩的数据（如图片）压缩后可能更大
    const deflated = raw.length > 0 ? deflateRawSync(raw) : Buffer.alloc(0);
    const useDeflate = raw.length > 0 && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method: 0 | 8 = useDeflate ? 8 : 0;

    const header = Buffer.alloc(30);
    writeUInt32(header, 0, 0x04034b50);
    writeUInt16(header, 4, 20); // version needed to extract (2.0)
    writeUInt16(header, 6, 0x0800); // flag: 文件名为 UTF-8
    writeUInt16(header, 8, method);
    writeUInt16(header, 10, time);
    writeUInt16(header, 12, date);
    writeUInt32(header, 14, crc);
    writeUInt32(header, 18, payload.length);
    writeUInt32(header, 22, raw.length);
    writeUInt16(header, 26, nameBuffer.length);
    writeUInt16(header, 28, 0); // extra field length

    prepared.push({
      nameBuffer,
      raw,
      payload,
      method,
      crc,
      localHeaderOffset: offset,
    });

    chunks.push(header, nameBuffer, payload);
    offset += header.length + nameBuffer.length + payload.length;
  }

  const centralDirectoryStart = offset;
  const centralChunks: Buffer[] = [];

  for (const entry of prepared) {
    const header = Buffer.alloc(46);
    writeUInt32(header, 0, 0x02014b50);
    writeUInt16(header, 4, 20); // version made by
    writeUInt16(header, 6, 20); // version needed
    writeUInt16(header, 8, 0x0800); // flag: UTF-8
    writeUInt16(header, 10, entry.method);
    writeUInt16(header, 12, time);
    writeUInt16(header, 14, date);
    writeUInt32(header, 16, entry.crc);
    writeUInt32(header, 20, entry.payload.length);
    writeUInt32(header, 24, entry.raw.length);
    writeUInt16(header, 28, entry.nameBuffer.length);
    writeUInt16(header, 30, 0); // extra length
    writeUInt16(header, 32, 0); // comment length
    writeUInt16(header, 34, 0); // disk number start
    writeUInt16(header, 36, 0); // internal attributes
    writeUInt32(header, 38, 0); // external attributes
    writeUInt32(header, 42, entry.localHeaderOffset);

    centralChunks.push(header, entry.nameBuffer);
    offset += header.length + entry.nameBuffer.length;
  }

  const centralDirectorySize = offset - centralDirectoryStart;

  const eocd = Buffer.alloc(22);
  writeUInt32(eocd, 0, 0x06054b50);
  writeUInt16(eocd, 4, 0); // this disk
  writeUInt16(eocd, 6, 0); // disk with central directory
  writeUInt16(eocd, 8, prepared.length);
  writeUInt16(eocd, 10, prepared.length);
  writeUInt32(eocd, 12, centralDirectorySize);
  writeUInt32(eocd, 16, centralDirectoryStart);
  writeUInt16(eocd, 20, 0); // comment length

  return Buffer.concat([...chunks, ...centralChunks, eocd]);
};
