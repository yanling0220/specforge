#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ForgeError } from '@specforge/core';
import { Store } from '@specforge/store';
import { DEFAULT_WEB_DIR, startServer } from './server.ts';

const HELP = `SpecForge server（只读）+ Web 控制台

在 SpecForge 项目目录中运行：
  sf-server [--port 4317] [--host 127.0.0.1] [--db <索引文件>]

REST
  GET /api/health
  GET /api/changes[?stage=]                      change 列表（含待回答 / 阻塞问题数）
  GET /api/changes/:id                           完整状态（文件为准）
  GET /api/changes/:id/gates                     全部门禁的实时评估
  GET /api/changes/:id/questions[?status=&severity=]
  GET /api/changes/:id/questions/:qid            问题的完整修订与核对历史
  GET /api/changes/:id/events[?type=&after=&limit=]
  GET /api/events[?changeId=&type=&after=&limit=]
  GET /api/changes/:id/evidence[/:eid]           验证证据与 G5 证据（hashOk 表示与事件日志一致）
  GET /api/log/verify                            哈希链与带外修改校验
WebSocket
  /ws[?changeId=&after=]                         推送 hello / event / changes / rebuilt

注意：目前没有登录（T4.1），默认只监听本机。`;

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

async function main(): Promise<void> {
  if (opts.help) {
    console.log(HELP);
    return;
  }
  const port = opts.port ? Number(opts.port) : 4317;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ForgeError('bad_arg', '--port 必须是 0–65535 的整数');
  const store = Store.find(process.cwd());
  const server = await startServer({ store, port, host: opts.host, dbPath: opts.db });
  if (opts.host && !['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
    console.log('⚠️  正在监听非本机地址；目前没有登录，任何能访问该地址的人都能读取全部数据');
  }
  console.log(`SpecForge server：${server.url}（项目 ${store.root}，${server.index.changes().length} 个 change）`);
  console.log(existsSync(join(DEFAULT_WEB_DIR, 'index.html')) ? `Web 控制台：${server.url}/` : 'Web 控制台未构建：npm run build -w @specforge/web（或开发时 npm run dev -w @specforge/web）');
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  if (e instanceof ForgeError) {
    console.error(`⛔ ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
});
