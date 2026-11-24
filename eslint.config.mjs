import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  { files: ['**/*.{js,mjs,cjs,ts}'], languageOptions: { globals: globals.node } },
  js.configs.recommended,
  { files: ['infra/mongo/*.js'], languageOptions: { globals: { db: 'readonly' } } },
  ...tseslint.configs.recommended,
];
