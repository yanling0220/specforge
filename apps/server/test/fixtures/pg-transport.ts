import { DatabaseSync } from 'node:sqlite';
import type { PgClient, PgPool } from '../../src/index-postgres.ts';

/** 注入 SQL 传输：SQLite 执行共有 SQL / 事务，不能替代真实 Postgres 验收。 */
export class TestPgPool implements PgPool {
  db = new DatabaseSync(':memory:');
  fail?: (sql: string) => boolean;
  delay?: () => Promise<void>;
  released = 0;
  destroyed = 0;
  ended = false;

  async connect(): Promise<PgClient> {
    if (this.fail?.('CONNECT')) throw new Error('postgres://secret-user:secret-password@private-host/db');
    return {
      query: async (query, args = []) => {
        await this.delay?.();
        if (this.fail?.(query)) throw new Error('secret-password query failure');
        if (query.startsWith('SELECT pg_advisory')) return { rows: [] };
        if (query.startsWith('SELECT to_regclass')) return { rows: this.db.prepare("SELECT name AS relation FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").all() };
        const sql = query.replace(/CREATE SCHEMA IF NOT EXISTS specforge_index;/g, '').replaceAll('specforge_index.', '').replaceAll(' FOR UPDATE', '').replaceAll(' COLLATE "C"', ' COLLATE BINARY');
        if (!args.length && !sql.trimStart().startsWith('SELECT')) { this.db.exec(sql); return { rows: [] }; }
        const values: (string | number | null)[] = [];
        const positional = sql.replace(/\$(\d+)/g, (_, number) => { values.push(args[Number(number) - 1] as string | number | null); return '?'; });
        const statement = this.db.prepare(positional);
        if (sql.startsWith('SELECT')) return { rows: statement.all(...values) };
        statement.run(...values);
        return { rows: [] };
      },
      release: (destroy) => { this.released++; if (destroy) this.destroyed++; },
    };
  }
  async end(): Promise<void> { if (!this.ended) { this.ended = true; this.db.close(); } }
}
