#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ForgeError } from '@specforge/core';
import { Store } from '@specforge/store';
import { DEFAULT_WEB_DIR, isLoopback, startMultiProjectServer, startServer } from './server.ts';
import { readProjects } from './projects.ts';

const HELP = `SpecForge server + Web 控制台

在 SpecForge 项目目录中运行：
  sf-server [--port 4317] [--host 127.0.0.1] [--db <索引文件>]

多项目服务（项目各自需要用户名册）：
  sf-server --projects <项目登记.json> [--port 4317] [--host 127.0.0.1]
  配置：{"version":1,"projects":[{"id":"demo","root":"/srv/demo"}]}
  项目接口：/p/<项目ID>/api/...；登录 /p/<项目ID>/api/auth/login；订阅 /p/<项目ID>/ws。
  Web 入口：/；项目链接：/p/<项目ID>/#/changes/<变更ID>/analysis/<问题ID>。
  各项目使用独立内存索引和读写接口；不支持 --db，不公开项目目录。

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

登录：启用用户名册（sf user add）后，用 sf user add / sf user token 生成的令牌登录；
  POST /api/auth/login {name, token}、GET /api/auth/me、POST /api/auth/logout。
  未启用名册时无需登录，且只能监听本机。`;

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    db: { type: 'string' },
    projects: { type: 'string' },
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
  if (opts.projects) {
    if (opts.db) throw new ForgeError('bad_arg', '--projects 不能与 --db 同时使用');
    const server = await startMultiProjectServer({ projects: readProjects(opts.projects), port, host: opts.host });
    console.log(`SpecForge 多项目服务：${server.url}（项目独立登录，接口前缀 /p/<项目ID>）`);
    console.log(existsSync(join(DEFAULT_WEB_DIR, 'index.html')) ? `Web 控制台：${server.url}/（使用管理员提供的项目 ID 或 /p/<项目ID>/ 链接）` : 'Web 控制台未构建：npm run web:build');
    if (opts.host && !isLoopback(opts.host)) console.log('非本机访问请放在 HTTPS 反向代理之后使用');
    const stop = () => void server.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  const store = Store.find(process.cwd());
  const server = await startServer({ store, port, host: opts.host, dbPath: opts.db });
  if (opts.host && !isLoopback(opts.host)) {
    console.log('⚠️  正在监听非本机地址：登录令牌与会话 Cookie 以明文 HTTP 传输，请放在 HTTPS 反向代理之后使用');
  }
  console.log(store.users() ? '已启用用户名册：需要用令牌登录' : '未启用用户名册：无需登录，仅限本机访问（sf user add 启用）');
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
