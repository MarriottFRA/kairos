import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['.vite/**', 'out/**', 'dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.electron,
  importPlugin.flatConfigs.typescript,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      // eslint-plugin-import parses imported .ts/.tsx files to check their
      // exports; without this it falls back to espree and reports every TS
      // file as a parse error.
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      // The codebase predates any type-checking (see the `typecheck` script,
      // added alongside this config) and carries ~110 `any`s. Keeping this as a
      // warning makes `npm run lint` actionable; tightening it to an error is
      // its own piece of work.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Build/install helper scripts are plain CommonJS, run by node directly.
    files: ['scripts/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // This config file imports dev-only packages the electron resolver
    // deliberately does not see.
    files: ['eslint.config.mjs'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
);
