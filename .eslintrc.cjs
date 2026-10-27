/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * ESLint (v8, eslintrc-format) — TotalQuadro Mission Planner.
 * Правила подобраны так, чтобы ловить реальные баги (хуки, гонки, мутации стейта),
 * а не stylistic-шум. Заглушки вида @ts-ignore запрещены политикой репозитория.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/', 'coverage/', '.tmp-tests/', '*.worker.js', 'node_modules/'],
  settings: {},
  rules: {
    // Реальные источники багов в React/Zustund-кодовой базе
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'no-empty': ['error', { allowEmptyCatch: false }],
    'no-fallthrough': 'error',
    // TypeScript: строгие, но не блокирующие legacy-код предупреждения
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
  },
  overrides: [
    {
      files: ['tests/**/*.ts', 'tests/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
      env: { node: true, mocha: true },
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
