/**
 * electron-builder afterPack 钩子。
 *
 * 职责：保证原生模块（napi .node）与 libmpv 运行时在打包产物中可用，
 * 缺失时给出明确告警而不是静默产出一个无法播放的包。
 *
 * 注意：extraResources 已声明这些资源；此钩子做的是「校验 + 兜底补拷」，
 * 避免因构建目录状态（例如 target 输出路径变化）导致产物缺文件。
 */
const fs = require('fs');
const path = require('path');

const NATIVE_MODULES = [
  'yan-media-controls',
  'yan-mpv-player',
  'yan-storage',
  'yan-spectrum-capture',
];

function log(message) {
  console.log(`[afterPack] ${message}`);
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');

  log(`platform=${context.electronPlatformName} arch=${context.arch} resources=${resourcesDir}`);

  const nativeDir = path.join(resourcesDir, 'native');
  fs.mkdirSync(nativeDir, { recursive: true });

  for (const name of NATIVE_MODULES) {
    const target = path.join(nativeDir, `${name}.node`);
    if (fs.existsSync(target)) {
      log(`ok native/${name}.node (${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB)`);
      continue;
    }
    const source = path.join(projectDir, 'native', name, `${name}.node`);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      log(`copied native/${name}.node from native/${name}/ (fallback)`);
    } else {
      log(`WARN missing native module: native/${name}/${name}.node — 构建产物将无法加载该原生模块`);
    }
  }

  const mpvDir = path.join(resourcesDir, 'mpv');
  if (fs.existsSync(mpvDir)) {
    const files = fs.readdirSync(mpvDir);
    log(`ok mpv/ (${files.length} entries)`);
    const hasLib = files.some((file) => /^(lib)?mpv-2?\.dll$/i.test(file) || /^libmpv/i.test(file));
    if (!hasLib) {
      log('WARN mpv/ 目录存在但没有 libmpv 动态库（libmpv-2.dll / mpv-2.dll）——播放引擎不可用');
    }
  } else {
    log('WARN 缺少 resources/mpv —— 播放引擎不可用（详见构建报告「已绕过项」）');
  }

  const serverDir = path.join(resourcesDir, 'server');
  if (fs.existsSync(serverDir)) {
    const moduleCount = fs.existsSync(path.join(serverDir, 'module'))
      ? fs.readdirSync(path.join(serverDir, 'module')).filter((f) => f.endsWith('.js')).length
      : 0;
    const utilCount = fs.existsSync(path.join(serverDir, 'util'))
      ? fs.readdirSync(path.join(serverDir, 'util')).filter((f) => f.endsWith('.js')).length
      : 0;
    log(`ok server/ (module=${moduleCount} util=${utilCount})`);
  } else {
    log('WARN 缺少 resources/server —— 内置 KuGou API 模块不可用');
  }

  const iconsDir = path.join(resourcesDir, 'icons');
  log(fs.existsSync(iconsDir) ? `ok icons/ (${fs.readdirSync(iconsDir).length} entries)` : 'WARN 缺少 resources/icons');
};
