/**
 * ESLint configuration for the Lemma project.
 *
 * Uses @typescript-eslint/parser so TypeScript syntax is understood, and
 * extends the @typescript-eslint/recommended rule set for type-aware linting.
 *
 * Notable rule overrides:
 *   no-console           — off: pipeline stages and spike scripts use console for progress reporting.
 *   no-require-imports   — off: CommonJS require.main === module guard is intentional in spike scripts.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '**/*.d.ts',
  ],
  rules: {
    // Pipeline stages and spike scripts emit structured progress lines to stdout/stderr by design
    'no-console': 'off',
    // CommonJS interop: require.main === module guards in spike scripts
    '@typescript-eslint/no-require-imports': 'off',
  },
};
