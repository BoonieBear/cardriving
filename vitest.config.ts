import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['client/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    globals: true,
  },
});
