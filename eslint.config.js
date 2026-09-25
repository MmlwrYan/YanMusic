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
