import pluginVue from 'eslint-plugin-vue';
import vueTsEslintConfig from '@vue/eslint-config-typescript';
import vuePrettierConfig from '@vue/eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'release/**',
      // Rust 构建产物目录（本仓 target/ 有 3000+ 文件 / 1.2 GB）。
      // 不忽略它会让 eslint 遍历整个构建目录：既拖慢 lint，
      // 又会在 cargo 并发写 target/ 时触发 scandir ENOENT 报错。
      'target/**',
      '**/*.json',
      '**/*.md',
      '**/*.d.ts',
      'public/**',
      'server/**',
      // 本地工具数据目录（.gitignore:61 已排除，与 docs/agent/ 同性质）。
      // 里面的脚本是**一次性过程工具**，不是产品代码：对它们跑 lint
      // 只会让 `pnpm lint` 因为「没用到的临时变量」「格式化」这类噪声变红，
      // 而 lint 在本项目是发布前的硬门禁（必须 0 error / 0 warning）。
      '.workbuddy/**',
      '.gitignore',
      '.DS_Store',
    ],
  },
  ...pluginVue.configs['flat/essential'],
  ...vueTsEslintConfig(),
  vuePrettierConfig,
  {
    rules: {
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          semi: true,
          trailingComma: 'all',
        },
      ],
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // 采用 typescript-eslint 官方推荐的「下划线前缀 = 刻意未使用」约定：
      //   - argsIgnorePattern / varsIgnorePattern：`_x` 明确表示「我故意不读它」；
      //   - ignoreRestSiblings：`const { a: _a, ...rest } = obj` 是「剔除某属性」
      //     的惯用写法，`_a` 的存在本身就是目的，删掉会改变 rest 的内容。
      // 例：src/renderer/utils/rendererMemoryDiagnostics.ts 用该写法把
      // naturalPixels / backingPixels 从对外返回的对象里剔除。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // CommonJS 文件里 `require` 是唯一可用的加载方式，该规则不适用。
    // 注意必须显式包含 .cjs：此前的 glob 只有 *.js，而仓库里的脚本实际是 *.cjs，
    // 导致 11 条 no-require-imports 误报（.mjs 属 ESM，不在此豁免范围内）。
    files: ['build/**/*.js', 'build/**/*.cjs', 'scripts/**/*.js', 'scripts/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
