import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/drizzle/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Second line of boundary defence, alongside dependency-cruiser: catches the
    // import at author time in the editor rather than at CI time.
    files: ['packages/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aerolith/modules-*', '../../*/src/**'],
              message:
                'Modules must not import each other. Use kernel events or a registered ' +
                'service contract. See docs/02-architecture.md.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/scripts/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
