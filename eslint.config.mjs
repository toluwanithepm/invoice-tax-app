import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.config.*', '**/next-env.d.ts', 'apps/api/scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "CallExpression[callee.property.name='$queryRawUnsafe']", message: 'Use tagged $queryRaw to keep queries parameterised.' }, { selector: "CallExpression[callee.property.name='$executeRawUnsafe']", message: 'Use tagged $executeRaw to keep queries parameterised.' }],
    },
  },
  {
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
