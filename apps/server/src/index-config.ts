import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError, sha256 } from '@specforge/core';
import type { Store } from '@specforge/store';
import { ForgeIndex } from './index-db.ts';
import type { QueryIndex } from './query-index.ts';

export type IndexConfig = { backend: 'sqlite' } | { backend: 'postgres'; connectionStringEnv: string; projectId?: string };

export function parseIndexConfig(value: unknown): IndexConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForgeError('bad_arg', '无效的索引配置');
  const config = value as Record<string, unknown>;
  if (config.backend === 'sqlite' && Object.keys(config).every((key) => key === 'backend')) return { backend: 'sqlite' };
  if (config.backend !== 'postgres' || Object.keys(config).some((key) => !['backend', 'connectionStringEnv', 'projectId'].includes(key)) || typeof config.connectionStringEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.connectionStringEnv) || (config.projectId !== undefined && (typeof config.projectId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.projectId)))) {
    throw new ForgeError('bad_arg', '索引配置只允许 backend、connectionStringEnv（环境变量名）与可选 projectId');
  }
  return { backend: 'postgres', connectionStringEnv: config.connectionStringEnv, ...(config.projectId ? { projectId: config.projectId as string } : {}) };
}

export function readIndexConfig(file: string): IndexConfig {
  try { return parseIndexConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new ForgeError('bad_arg', '无法读取索引配置，请核对 JSON 和允许的字段'); }
}

/** 索引登记身份不包含凭据；ID 不可静默换绑另一目录或被替换的仓库。 */
export function indexIdentity(store: Store): string {
  const root = realpathSync(store.root);
  const repository = statSync(join(root, '.git'));
  return sha256(JSON.stringify([root, repository.dev, repository.ino]));
}

export async function createIndex(store: Store, options: { indexConfig?: IndexConfig; projectId?: string; dbPath?: string }): Promise<QueryIndex> {
  const config = parseIndexConfig(options.indexConfig ?? { backend: 'sqlite' });
  if (config.backend === 'sqlite') return new ForgeIndex(store, options.dbPath);
  if (options.dbPath) throw new ForgeError('bad_arg', 'Postgres 不能与 --db 同时使用');
  const projectId = options.projectId ?? config.projectId;
  if (!projectId || (options.projectId && config.projectId)) throw new ForgeError('bad_arg', '单项目 Postgres 必须配置 projectId；多项目使用登记 ID，不能另设 projectId');
  const connectionString = process.env[config.connectionStringEnv];
  if (!connectionString) throw new ForgeError('bad_arg', 'Postgres 连接环境变量未设置');
  // 默认路径不加载驱动，也不读取或连接数据库。
  const { PostgresIndex } = await import('./index-postgres.ts');
  return PostgresIndex.open(store, projectId, connectionString);
}
