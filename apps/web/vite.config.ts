import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };

// 开发时把接口代理到 server（默认 4317）；构建产物由 server 直接托管
const target = process.env.SPECFORGE_SERVER ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});
