import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Live tests talk to a real Codex login and spend subscription quota; opt in explicitly.
    exclude: process.env.INKBRIDGE_LIVE === '1' ? [] : ['tests/live/**'],
    testTimeout: 15_000,
  },
})
