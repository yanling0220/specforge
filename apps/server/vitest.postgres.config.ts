import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['apps/server/integration/index.postgres.ts'], testTimeout: 30_000, maxWorkers: 1 },
});
