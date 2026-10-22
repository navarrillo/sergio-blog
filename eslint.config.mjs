import tseslint from 'typescript-eslint';
export default [
  {
    ignores: [
      'dist/**',
      '.astro/**',
      'node_modules/**',
      '.local/**',
      'data/**',
      'uploads/**',
      'backups/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
