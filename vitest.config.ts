import { defineConfig } from 'vitest/config';

// 集成测试会启动 git、node --test 与 HTTP 服务，并行运行时单个用例可能超过默认的 5 秒
export default defineConfig({
  test: { testTimeout: 20_000 },
});
