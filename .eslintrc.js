/**
 * ESLint configuration for the Lemma project.
 *
 * Uses @typescript-eslint/parser so TypeScript syntax is understood, and
 * extends the @typescript-eslint/recommended rule set for type-aware linting.
 *
 * Notable rule overrides:
 *   no-console           — off: spike scripts use console for progress reporting.
 *   no-require-imports   — off: CommonJS require.main === module guard is intentional.
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
    // Spike scripts emit structured progress lines to stdout/stderr by design
    'no-console': 'off',
    // CommonJS interop: require.main === module guards and dynamic require() calls
    '@typescript-eslint/no-require-imports': 'off',
  },
};
