import { DatabaseSync } from 'node:sqlite';
import { isResolved } from '@specforge/core';
import type { Store } from '@specforge/store';
import type { ForgeEvent } from '@specforge/shared';

// SQLite 只是 .specforge/ 的索引（文件为准）：用于列表、过滤与分页查询。
// 详情与门禁评估一律直接读文件、实时计算。索引可随时丢弃重建。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, tier TEXT NOT NULL, stage TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  open_questions INTEGER NOT NULL, open_blocking INTEGER NOT NULL,
  fix_rounds INTEGER NOT NULL, escalated INTEGER NOT NULL,
  last_event_seq INTEGER, last_event_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  change_id TEXT NOT NULL, id TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
  category TEXT NOT NULL, question TEXT NOT NULL, required_roles TEXT NOT NULL,
  raised_at_stage TEXT NOT NULL, raised_by TEXT NOT NULL, raised_at TEXT NOT NULL, task_ids TEXT NOT NULL,
  PRIMARY KEY (change_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, type TEXT NOT NULL, change_id TEXT, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL,
  at TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_change ON events (change_id, seq);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
`;

export interface ChangeRow {
  id: string;
  title: string;
  tier: string;
  stage: string;
  createdAt: string;
  createdBy: string;
  openQuestions: number;
  openBlocking: number;
  fixRounds: number;
  escalated: boolean;
  lastEventSeq: number | null;
  lastEventAt: string | null;
}

export interface QuestionRow {
  changeId: string;
  id: string;
  severity: string;
  status: string;
  category: string;
  question: string;
  requiredRoles: string[];
  raisedAtStage: string;
  raisedBy: string;
  raisedAt: string;
  taskIds: string[];
}

export interface SyncResult {
  /** 新索引的事件 */
  events: ForgeEvent[];
  /** 重新索引的 change */
  changes: string[];
  /** 事件日志与索引不一致（被改写或截断），做了全量重建 */
  rebuilt: boolean;
}

export interface EventQuery {
  changeId?: string;
  type?: string;
  /** 只返回 seq 大于此值的事件 */
  after?: number;
  limit?: number;
}

export class ForgeIndex {
  private db: DatabaseSync;
  private store: Store;

  constructor(store: Store, path = ':memory:') {
    this.store = store;
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private lastSeq(): number {
    return (this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number | null }).seq ?? 0;
  }

  private hashAt(seq: number): string | undefined {
    return (this.db.prepare('SELECT hash FROM events WHERE seq = ?').get(seq) as { hash: string } | undefined)?.hash;
  }

  /**
   * 与文件同步：追加新事件，重新索引受影响的 change。
   * 若已索引的最后一条事件与文件不一致（日志被改写或截断），丢弃索引全量重建。
   */
  sync(): SyncResult {
    const all = this.store.events();
    const last = this.lastSeq();
    const known = last ? all.find((e) => e.seq === last) : undefined;
    const rebuilt = last > 0 && known?.hash !== this.hashAt(last);
    if (rebuilt) this.db.exec('DELETE FROM events; DELETE FROM changes; DELETE FROM questions;');
    const fresh = rebuilt ? all : all.filter((e) => e.seq > last);

    const insert = this.db.prepare('INSERT INTO events (seq, type, change_id, actor_name, actor_role, at, hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const e of fresh) insert.run(e.seq, e.type, e.changeId ?? null, e.actor.name, e.actor.role, e.at, e.hash, JSON.stringify(e));
      // 首次同步或重建时索引全部 change（也包括没有事件的目录）；之后只索引有新事件的 change
      const ids = last === 0 || rebuilt ? this.store.listChanges() : [...new Set(fresh.flatMap((e) => (e.changeId ? [e.changeId] : [])))];
      for (const id of ids) this.indexChange(id);
      this.db.exec('COMMIT');
      return { events: fresh, changes: ids, rebuilt };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private indexChange(id: string): void {
    this.db.prepare('DELETE FROM changes WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM questions WHERE change_id = ?').run(id);
    if (!this.store.listChanges().includes(id)) return;
    const { change, questions } = this.store.load(id);
    const open = questions.filter((q) => !isResolved(q));
    const lastEvent = this.db.prepare('SELECT seq, at FROM events WHERE change_id = ? ORDER BY seq DESC LIMIT 1').get(id) as { seq: number; at: string } | undefined;
    this.db
      .prepare('INSERT INTO changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        change.id,
        change.title,
        change.tier,
        change.stage,
        change.createdAt,
        change.createdBy.name,
        open.length,
        open.filter((q) => q.severity === 'blocking').length,
        change.fixRounds?.length ?? 0,
        change.escalation ? 1 : 0,
        lastEvent?.seq ?? null,
        lastEvent?.at ?? null,
      );
    const insert = this.db.prepare('INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const q of questions) {
      insert.run(id, q.id, q.severity, q.status, q.category, q.question, JSON.stringify(q.requiredRoles), q.raisedAtStage, q.raisedBy.name, q.raisedAt, JSON.stringify(q.taskIds ?? []));
    }
  }

  changes(filter: { stage?: string } = {}): ChangeRow[] {
    const rows = (
      filter.stage ? this.db.prepare('SELECT * FROM changes WHERE stage = ? ORDER BY id').all(filter.stage) : this.db.prepare('SELECT * FROM changes ORDER BY id').all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      tier: r.tier as string,
      stage: r.stage as string,
      createdAt: r.created_at as string,
      createdBy: r.created_by as string,
      openQuestions: r.open_questions as number,
      openBlocking: r.open_blocking as number,
      fixRounds: r.fix_rounds as number,
      escalated: r.escalated === 1,
      lastEventSeq: (r.last_event_seq as number | null) ?? null,
      lastEventAt: (r.last_event_at as string | null) ?? null,
    }));
  }

  questions(changeId: string, filter: { status?: string; severity?: string } = {}): QuestionRow[] {
    const where = ['change_id = ?'];
    const args: string[] = [changeId];
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    if (filter.severity) (where.push('severity = ?'), args.push(filter.severity));
    const rows = this.db.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')}`).all(...args) as Record<string, unknown>[];
    const num = (id: string) => Number(id.replace(/\D/g, ''));
    return rows
      .map((r) => ({
        changeId: r.change_id as string,
        id: r.id as string,
        severity: r.severity as string,
        status: r.status as string,
        category: r.category as string,
        question: r.question as string,
        requiredRoles: JSON.parse(r.required_roles as string) as string[],
        raisedAtStage: r.raised_at_stage as string,
        raisedBy: r.raised_by as string,
        raisedAt: r.raised_at as string,
        taskIds: JSON.parse(r.task_ids as string) as string[],
      }))
      .sort((a, b) => num(a.id) - num(b.id));
  }

  events(q: EventQuery = {}): ForgeEvent[] {
    const where = ['seq > ?'];
    const args: (string | number)[] = [q.after ?? 0];
    if (q.changeId) (where.push('change_id = ?'), args.push(q.changeId));
    if (q.type) (where.push('type = ?'), args.push(q.type));
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const rows = this.db.prepare(`SELECT json FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ${limit}`).all(...args) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ForgeEvent);
  }
}
