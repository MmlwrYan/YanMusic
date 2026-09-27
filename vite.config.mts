import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

const analyzeBundle = process.env.ANALYZE_BUNDLE === '1';
const bundleAnalysisPlugin = () => ({
  name: 'yan-bundle-analysis',
  generateBundle(
    _options: unknown,
    bundle: Record<string, { type: string; code?: string; source?: unknown }>,
  ) {
    if (!analyzeBundle) return;

    const assets = Object.entries(bundle)
      .map(([fileName, item]) => {
        const size =
          item.type === 'chunk'
            ? Buffer.byteLength(item.code ?? '', 'utf8')
            : typeof item.source === 'string'
              ? Buffer.byteLength(item.source, 'utf8')
              : item.source instanceof Uint8Array
                ? item.source.byteLength
                : 0;
        return { fileName, type: item.type, size };
      })
      .sort((a, b) => b.size - a.size);

    mkdirSync('release', { recursive: true });
    writeFileSync(
      'release/bundle-report.json',
      JSON.stringify({ generatedAt: new Date().toISOString(), assets }, null, 2),
    );
  },
});

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        desktopLyric: resolve(__dirname, 'desktop-lyric.html'),
        pluginWindow: resolve(__dirname, 'plugin-window.html'),
      },
    },
  },
  plugins: [
    vue(),
    tailwindcss(),
    bundleAnalysisPlugin(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            emptyOutDir: true,
            // 主进程必须打成「单个文件」，禁止做 code splitting。
            //
            // 背景（v1.2.4 启动即崩的根因）：vite-plugin-electron 1.x 在 Vite 8
            // （rolldown 引擎）下不再把 `codeSplitting` 转译成 `inlineDynamicImports`，
            // 于是主进程被切成 index / settings / app 三个 chunk。rolldown 会把每个
            // 模块体包成惰性初始化 thunk，thunk 的求值顺序在存在循环依赖时会与源码
            // 顺序不一致：
            //   logger -> storage/settings -> storage/kv -> logger（循环）
            // 结果是 logger 的 thunk 先于 storage/settings 求值，logger 顶层对
            // getPersistedLogSettings() 的调用拿到 undefined，运行时抛
            // 「TypeError: <minified> is not a function」。
            // 置 codeSplitting: false 后主进程恢复为单文件，模块顺序与源码一致。
            //
            // 注意：Vite 8 走 rolldown，配置项是 `rolldownOptions`；在 Vite <8 上
            // `rollupOptions` + `output.inlineDynamicImports` 才有效。两者都写上，
            // 以兼容未来的 Vite 版本切换。
            rolldownOptions: {
              external: [
                'electron',
                'font-list',
                'electron-audio-loopback',
                '../../native/yan-media-controls',
                '../../native/yan-mpv-player',
                '../../native/yan-storage',
                '../../native/yan-spectrum-capture',
              ],
              output: {
                codeSplitting: false,
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
              },
            },
            rollupOptions: {
              external: [
                'electron',
                'font-list',
                'electron-audio-loopback',
                '../../native/yan-media-controls',
                '../../native/yan-mpv-player',
                '../../native/yan-storage',
                '../../native/yan-spectrum-capture',
              ],
              output: {
                inlineDynamicImports: true,
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
              },
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload', // 明确预加载脚本输出目录
            emptyOutDir: true,
            rolldownOptions: {
              output: {
                codeSplitting: false,
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
              },
            },
          },
        },
      },
    ]),
    renderer(),
  ].filter(Boolean),
  server: {
    // dev 模式下 API 请求通过 IPC 直连 main 进程，不再需要 HTTP proxy
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
    },
    extensions: ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.json', '.vue'],
  },
});
