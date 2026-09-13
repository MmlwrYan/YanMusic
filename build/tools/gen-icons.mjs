// YanMusic 图标打包器（零依赖：node:zlib 手写 PNG/ICO/ICNS 编码）
//
// 设计源位于 build/icons/references/：
//   - icon.svg                   通用应用图标矢量稿（1024×1024，白底圆角 + 「Yan」+「MUSIC」）
//   - icon_macos.svg             macOS 应用图标矢量稿（主体占中间 824×824，四周透明安全边距）
//   - mac_tray_icon_template.svg macOS 托盘模板稿（黑色圆角方块 + 镂空「Yan」）
// 托盘另有两个同几何变体由本文件的 buildTraySvg() 生成：
//   - trayDark  = 白色圆角方块 + 镂空「Yan」（Windows 深色任务栏）
//   - trayLight = 黑色圆角方块 + 镂空「Yan」（Windows 浅色任务栏）
//   - trayBlue  = #0071E3 圆角方块 + 白色「Yan」（Linux / Windows 托盘彩色图标）
//
// 栅格化由 Electron（Chromium canvas）在临时目录完成，本文件只负责：
//   1) 输出 ICON_SPEC（designs / jobs / outputs），供栅格化脚本与打包共同使用；
//   2) 把栅格化好的 PNG 组装成 icon.ico / icon.icns 并复制到最终文件名。
//
// 用法：
//   node build/tools/gen-icons.mjs --png-dir <已栅格化 PNG 目录> [--out <输出目录>]
//   node build/tools/gen-icons.mjs --spec          # 打印栅格化任务清单（JSON）
//
// 说明：本文件不再自带几何渲染器（旧的紫色占位方块画法已废弃），
// 所有位图均来自 references/ 下的矢量稿经 Chromium 栅格化的结果。
import { deflateSync } from 'node:zlib';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultOutDir = resolve(here, '..', 'icons');

// ---------------------------------------------------------------- 设计规格

const TRAY_FONT =
  'font-family="system-ui, -apple-system, sans-serif" font-size="650" font-weight="950" ' +
  'text-anchor="middle" textLength="850" lengthAdjust="spacingAndGlyphs"';

/**
 * 生成托盘图标 SVG（1024×1024 视图，与 mac_tray_icon_template.svg 完全同几何）。
 * @param {{fill: string, textFill?: string}} options
 *   fill     圆角方块颜色
 *   textFill 若给出，则文字为实色填充；否则文字用遮罩镂空（透明）
 */
export function buildTraySvg({ fill, textFill }) {
  const text = (color) => `<text x="512" y="700" ${TRAY_FONT} fill="${color}">Yan</text>`;
  if (textFill) {
    return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" rx="180" fill="${fill}"/>
  ${text(textFill)}
</svg>`;
  }
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <mask id="tray-icon-mask">
      <rect width="1024" height="1024" rx="180" fill="white"/>
      ${text('black')}
    </mask>
  </defs>
  <rect width="1024" height="1024" rx="180" fill="${fill}" mask="url(#tray-icon-mask)"/>
</svg>`;
}

const APP_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const WINDOWS_TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64];
const TRAY_COLOR_SIZES = [16, 24, 32, 64, 256];

export const ICON_SPEC = {
  // design -> 矢量来源（svg 文件相对 build/icons 目录，或 inline 生成函数）
  designs: {
    app: { svg: 'references/icon.svg' },
    appMacos: { svg: 'references/icon_macos.svg' },
    trayTemplate: { svg: 'references/mac_tray_icon_template.svg' },
    trayDark: { tray: { fill: '#FFFFFF' } },
    trayLight: { tray: { fill: '#000000' } },
    trayBlue: { tray: { fill: '#0071E3', textFill: '#FFFFFF' } },
  },
  // 需要栅格化的位图清单（尺寸均为 1x 实际像素）
  jobs: [
    ...APP_ICO_SIZES.map((size) => ({ design: 'app', size })),
    { design: 'app', size: 512 },
    { design: 'app', size: 1024 },
    { design: 'appMacos', size: 1024 },
    { design: 'trayTemplate', size: 16 },
    { design: 'trayTemplate', size: 32 },
    { design: 'trayTemplate', size: 64 },
    { design: 'trayTemplate', size: 1024 },
    ...WINDOWS_TRAY_SIZES.map((size) => ({ design: 'trayDark', size })),
    ...WINDOWS_TRAY_SIZES.map((size) => ({ design: 'trayLight', size })),
    ...TRAY_COLOR_SIZES.map((size) => ({ design: 'trayBlue', size })),
  ],
};

// ICNS 块类型 → 像素尺寸（PNG 型块，大端序）
export const ICNS_BLOCKS = [
  ['icp4', 16], // 16×16
  ['icp5', 32], // 32×32
  ['ic11', 32], // 16×16@2x
  ['ic12', 64], // 32×32@2x
  ['ic07', 128], // 128×128
  ['ic13', 256], // 128×128@2x
  ['ic08', 256], // 256×256
  ['ic14', 512], // 256×256@2x
  ['ic09', 512], // 512×512
  ['ic10', 1024], // 512×512@2x
];

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO / ICNS

/** entries: [{ size, png: Buffer }]，PNG 条目（Vista+ 支持任意尺寸使用 PNG） */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.png)]);
}

/** blocks: [{ type, png: Buffer }]（PNG 型 ICNS 块，全部大端序） */
export function encodeIcns(blocks) {
  const parts = blocks.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------- 组装

const readPng = (pngDir, design, size) => readFileSync(join(pngDir, `${design}-${size}.png`));

function assemble(pngDir, outDir) {
  const results = [];
  mkdirSync(join(outDir, 'references'), { recursive: true });

  const emit = (name, buf) => {
    writeFileSync(join(outDir, name), buf);
    results.push(`${name}\t${buf.length}`);
  };
  const emitCopy = (name, design, size) => {
    const buf = readPng(pngDir, design, size);
    writeFileSync(join(outDir, name), buf);
    results.push(`${name}\t${buf.length}`);
  };

  // Windows / 通用应用图标
  emit(
    'icon.ico',
    encodeIco(APP_ICO_SIZES.map((size) => ({ size, png: readPng(pngDir, 'app', size) }))),
  );
  // macOS 应用图标（PNG 型块）
  emit('icon.icns', encodeIcns(ICNS_BLOCKS.map(([type, size]) => ({ type, png: readPng(pngDir, 'app', size) }))));
  emitCopy('icon.png', 'app', 1024);
  emitCopy('icon_macos.png', 'appMacos', 1024);
  emitCopy(join('references', 'icon_macos.png'), 'appMacos', 1024);
  // macOS 托盘模板图（黑色圆角方块 + 镂空 Yan，纯黑 + alpha）
  emitCopy('IconTemplate.png', 'trayTemplate', 16);
  emitCopy('IconTemplate@2x.png', 'trayTemplate', 32);
  emitCopy('tray_icon_source.png', 'trayTemplate', 64);
  emitCopy(join('references', 'mac_tray_icon_template.png'), 'trayTemplate', 1024);
  // Linux
  emitCopy('linux_256x256.png', 'app', 256);
  emitCopy('linux_tray_icon.png', 'trayBlue', 64);
  // Windows 托盘（彩色圆角方块 + 白色 Yan）
  emit(
    'win_tray_icon.ico',
    encodeIco([16, 24, 32].map((size) => ({ size, png: readPng(pngDir, 'trayBlue', size) }))),
  );
  // 参考稿：深/浅色托盘 ICO
  emit(
    join('references', 'win_tray_icon_dark.ico'),
    encodeIco(WINDOWS_TRAY_SIZES.map((size) => ({ size, png: readPng(pngDir, 'trayDark', size) }))),
  );
  emit(
    join('references', 'win_tray_icon_light.ico'),
    encodeIco(WINDOWS_TRAY_SIZES.map((size) => ({ size, png: readPng(pngDir, 'trayLight', size) }))),
  );

  return results;
}

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// 仅作为入口脚本时才执行 CLI（被栅格化脚本 import 时只导出规格）
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  if (args.includes('--spec')) {
    console.log(JSON.stringify(ICON_SPEC, null, 2));
    process.exit(0);
  }
  const pngDir = argValue('--png-dir') ?? process.env.YAN_ICON_PNG_DIR;
  const outDir = resolve(argValue('--out') ?? defaultOutDir);
  if (!pngDir) {
    console.error(
      '缺少 --png-dir（栅格化 PNG 目录）。\n' +
        '用法: node build/tools/gen-icons.mjs --png-dir <dir> [--out <dir>]\n' +
        '栅格化请使用 Electron 脚本按 ICON_SPEC.jobs（--spec）逐项渲染。',
    );
    process.exit(1);
  }
  console.log(assemble(resolve(pngDir), outDir).join('\n'));
}
