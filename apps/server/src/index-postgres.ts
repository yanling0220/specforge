import { Pool } from 'pg';
import { ForgeError, isResolved } from '@specforge/core';
import type { Store } from '@specforge/store';
import type { ForgeEvent } from '@specforge/shared';
import { indexIdentity } from './index-config.ts';
import type { ChangeRow, EventQuery, QuestionRow, SyncResult } from './index-db.ts';
import type { IndexStatus, QueryIndex } from './query-index.ts';

/** 固定命名空间，绝不依赖客户端提供表名或 SQL。v1 仅为可重建索引。 */
export const POSTGRES_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS specforge_index;
CREATE TABLE IF NOT EXISTS specforge_index.schema_version (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
INSERT INTO specforge_index.schema_version VALUES (1, 1) ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS specforge_index.projects (
  project_id TEXT PRIMARY KEY, identity TEXT NOT NULL, last_seq BIGINT NOT NULL DEFAULT 0,
  last_hash TEXT, initialized INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS specforge_index.changes (
  project_id TEXT NOT NULL REFERENCES specforge_index.projects(project_id), id TEXT NOT NULL,
  stage TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS specforge_index.questions (
  project_id TEXT NOT NULL REFERENCES specforge_index.projects(project_id), change_id TEXT NOT NULL,
  id TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (project_id, change_id, id)
);
CREATE TABLE IF NOT EXISTS specforge_index.events (
  project_id TEXT NOT NULL REFERENCES specforge_index.projects(project_id), seq BIGINT NOT NULL,
  change_id TEXT, type TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);
CREATE INDEX IF NOT EXISTS events_change ON specforge_index.events (project_id, change_id, seq);
CREATE INDEX IF NOT EXISTS events_type ON specforge_index.events (project_id, type, seq);
`;

export interface PgClient {
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export class PostgresIndex implements QueryIndex {
  private current: IndexStatus = { backend: 'postgres', state: 'unavailable', lastSyncedSeq: 0 };
  private closed = false;
  private store: Store;
  private projectId: string;
  private pool: PgPool;

  /** pool 注入只供契约与故障测试；生产入口使用 open。 */
  constructor(store: Store, projectId: string, pool: PgPool) {
    this.store = store;
    this.projectId = projectId;
    this.pool = pool;
  }

  static async open(store: Store, projectId: string, connectionString: string): Promise<PostgresIndex> {
    const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, application_name: 'specforge-index' });
    const index = new PostgresIndex(store, projectId, pool);
    pool.on('error', () => { index.failed(); });
    try { await index.initialize(); return index; }
    catch (error) { await index.close(); throw error; }
  }

  status(): IndexStatus { return { ...this.current }; }
  private failed(): void { this.current.state = this.current.state === 'unavailable' ? 'unavailable' : 'stale'; }

  private async database<T>(operation: (client: PgClient) => Promise<T>, transaction = false): Promise<T> {
    let client: PgClient | undefined;
    let began = false;
    let destroy = false;
    try {
      if (this.closed) throw new Error('closed');
      client = await this.pool.connect();
      if (transaction) { await client.query('BEGIN'); began = true; }
      const value = await operation(client);
      if (transaction) await client.query('COMMIT');
      return value;
    } catch (error) {
      this.failed();
      if (client && began) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
      }
      if (error instanceof ForgeError) throw error;
      // 驱动异常可能包含用户、SQL、主机或连接串，禁止向 HTTP / 日志透传。
      throw new ForgeError('index_unavailable', 'Postgres 索引不可用，请联系管理员；业务操作不会自动重试');
    } finally { client?.release(destroy); }
  }

  async initialize(): Promise<void> {
    await this.database(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(734621009)');
      await client.query(POSTGRES_SCHEMA);
      const version = (await client.query('SELECT version FROM specforge_index.schema_version WHERE singleton = 1')).rows[0]?.version;
      if (version !== 1) throw new ForgeError('index_schema', '不支持此 Postgres 索引 schema 版本，请核对升级说明');
      await client.query('INSERT INTO specforge_index.projects (project_id, identity) VALUES ($1, $2) ON CONFLICT (project_id) DO NOTHING', [this.projectId, indexIdentity(this.store)]);
      const project = (await client.query('SELECT identity FROM specforge_index.projects WHERE project_id = $1 FOR UPDATE', [this.projectId])).rows[0];
      if (project?.identity !== indexIdentity(this.store)) throw new ForgeError('index_identity', '项目 ID 已绑定其他仓库，请核对登记与迁移说明');
    }, true);
  }

  async sync(options: { rebuild?: boolean } = {}): Promise<SyncResult> {
    try { return await this.store.exclusive(async () => {
      const all = this.store.events();
      const result = await this.database(async (client) => {
        const project = (await client.query('SELECT * FROM specforge_index.projects WHERE project_id = $1 FOR UPDATE', [this.projectId])).rows[0];
        if (!project || project.identity !== indexIdentity(this.store)) throw new ForgeError('index_identity', '项目索引登记已改变，请联系管理员');
        const last = Number(project.last_seq);
        const known = all.find((event) => event.seq === last);
        const rebuilt = !!options.rebuild || (last > 0 && known?.hash !== project.last_hash);
        if (rebuilt) for (const table of ['questions', 'changes', 'events']) await client.query(`DELETE FROM specforge_index.${table} WHERE project_id = $1`, [this.projectId]);
        const fresh = rebuilt ? all : all.filter((event) => event.seq > last);
        for (const event of fresh) await client.query('INSERT INTO specforge_index.events (project_id, seq, change_id, type, hash, json) VALUES ($1, $2, $3, $4, $5, $6)', [this.projectId, event.seq, event.changeId ?? null, event.type, event.hash, JSON.stringify(event)]);
        const available = this.store.listChanges();
        const ids = !project.initialized || rebuilt ? available : [...new Set(fresh.flatMap((event) => event.changeId ? [event.changeId] : []))];
        for (const id of ids) {
          await client.query('DELETE FROM specforge_index.questions WHERE project_id = $1 AND change_id = $2', [this.projectId, id]);
          await client.query('DELETE FROM specforge_index.changes WHERE project_id = $1 AND id = $2', [this.projectId, id]);
          if (!available.includes(id)) continue;
          const { change, questions } = this.store.load(id);
          const open = questions.filter((question) => !isResolved(question));
          const lastEvent = all.findLast((event) => event.changeId === id);
          const row: ChangeRow = { id, title: change.title, tier: change.tier, stage: change.stage, createdAt: change.createdAt, createdBy: change.createdBy.name, openQuestions: open.length, openBlocking: open.filter((question) => question.severity === 'blocking').length, fixRounds: change.fixRounds?.length ?? 0, escalated: !!change.escalation, lastEventSeq: lastEvent?.seq ?? null, lastEventAt: lastEvent?.at ?? null };
          await client.query('INSERT INTO specforge_index.changes (project_id, id, stage, data) VALUES ($1, $2, $3, $4)', [this.projectId, id, row.stage, JSON.stringify(row)]);
          for (const question of questions) {
            const row: QuestionRow = { changeId: id, id: question.id, severity: question.severity, status: question.status, category: question.category, question: question.question, requiredRoles: question.requiredRoles, raisedAtStage: question.raisedAtStage, raisedBy: question.raisedBy.name, raisedAt: question.raisedAt, taskIds: question.taskIds ?? [] };
            await client.query('INSERT INTO specforge_index.questions (project_id, change_id, id, status, severity, data) VALUES ($1, $2, $3, $4, $5, $6)', [this.projectId, id, row.id, row.status, row.severity, JSON.stringify(row)]);
          }
        }
        await client.query('UPDATE specforge_index.projects SET last_seq = $2, last_hash = $3, initialized = 1 WHERE project_id = $1', [this.projectId, all.at(-1)?.seq ?? 0, all.at(-1)?.hash ?? null]);
        return { events: fresh, changes: ids, rebuilt };
      }, true);
      this.current = { backend: 'postgres', state: 'ready', lastSyncedSeq: all.at(-1)?.seq ?? 0 };
      return result;
    }); } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'write_busy')) this.failed();
      throw error;
    }
  }

  private async rows<T>(sql: string, args: unknown[], column = 'data'): Promise<T[]> {
    if (this.current.state !== 'ready') throw new ForgeError('index_unavailable', '索引尚未同步，请稍后重试');
    return this.database(async (client) => (await client.query(sql, args)).rows.map((row) => JSON.parse(row[column] as string) as T));
  }

  async changes(filter: { stage?: string } = {}): Promise<ChangeRow[]> {
    return this.rows(`SELECT data FROM specforge_index.changes WHERE project_id = $1${filter.stage ? ' AND stage = $2' : ''} ORDER BY id COLLATE "C"`, filter.stage ? [this.projectId, filter.stage] : [this.projectId]);
  }

  async questions(changeId: string, filter: { status?: string; severity?: string } = {}): Promise<QuestionRow[]> {
    const where = ['project_id = $1', 'change_id = $2'];
    const args: unknown[] = [this.projectId, changeId];
    for (const key of ['status', 'severity'] as const) if (filter[key]) { args.push(filter[key]); where.push(`${key} = $${args.length}`); }
    const rows = await this.rows<QuestionRow>(`SELECT data FROM specforge_index.questions WHERE ${where.join(' AND ')}`, args);
    return rows.sort((a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  }

  async events(query: EventQuery = {}): Promise<ForgeEvent[]> {
    const where = ['project_id = $1', 'seq > $2'];
    const args: unknown[] = [this.projectId, query.after ?? 0];
    for (const [key, value] of [['change_id', query.changeId], ['type', query.type]]) if (value) { args.push(value); where.push(`${key} = $${args.length}`); }
    args.push(Math.min(Math.max(query.limit ?? 200, 1), 1000));
    return this.rows(`SELECT json FROM specforge_index.events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT $${args.length}`, args, 'json');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.current.state = 'unavailable';
    await this.pool.end();
  }
}
