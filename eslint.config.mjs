import Module from 'node:module';

// TypeScript 7 currently ships a compiler API that typescript-eslint does not
// consume yet. Keep the project compiler on TS 7 while routing only the lint
// toolchain's `typescript` imports to the supported side-by-side TS 6 API.
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
