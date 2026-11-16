import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgresIndex } from '../src/index-postgres.ts';
import { indexContract } from '../test/fixtures/index-contract.ts';

// 只在显式命令中运行，不读取 DATABASE_URL，不接触默认开发或生产数据库。
const connectionString = process.env.SF_POSTGRES_TEST_URL;
if (!connectionString) throw new Error('请先授权使用专用测试库，并设置 SF_POSTGRES_TEST_URL');
const prefix = `test-${randomUUID().slice(0, 8)}`;
const ids: string[] = [];

indexContract('真实 Postgres 查询索引契约', async (store, id) => {
  const projectId = `${prefix}-${ids.length}-${id}`;
  ids.push(projectId);
  return PostgresIndex.open(store, projectId, connectionString);
});

afterAll(async () => {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['questions', 'changes', 'events', 'projects']) await client.query(`DELETE FROM specforge_index.${table} WHERE project_id = ANY($1::text[])`, [ids]);
    await client.query('COMMIT');
  } finally { client.release(); await pool.end(); }
});
