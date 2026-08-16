import Module from 'node:module';

// TypeScript 7 does not yet expose a stable programmatic API that
// typescript-eslint can consume (peer range remains `>=4.8.4 <6.1.0`).
// Keep the project compiler on TS 7 while routing only the lint toolchain's
// `typescript` imports to the side-by-side TS 6.0.x API package alias.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('typescript') && /@typescript-eslint|ts-api-utils/.test(parent?.filename || '')) {
    const lintTypescriptRequest = request.replace(/^typescript/, 'typescript-eslint-typescript');
    return originalResolveFilename.call(this, lintTypescriptRequest, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const [{ default: tseslint }, { default: tsParser }] = await Promise.all([
  import('@typescript-eslint/eslint-plugin'),
  import('@typescript-eslint/parser'),
]);

export default [
  {
    ignores: [
      '.astro/**',
      'dist/**',
      'drizzle/**',
      'node_modules/**',
      'public/**',
      'worker-configuration.d.ts',
      '**/*.test.ts',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
