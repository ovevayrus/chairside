import { defineConfig } from 'vitest/config'

// Explicit per-project includes so compiled output in dist/ is never collected as tests.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'scripts', root: './scripts', include: ['**/*.test.mjs'] } },
      {
        extends: true,
        test: { name: '@chairside/shared', root: './packages/shared', include: ['tests/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: '@chairside/server', root: './apps/server', include: ['tests/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: '@chairside/glasses', root: './apps/glasses', include: ['tests/**/*.test.ts'] },
      },
    ],
  },
})
