import type { ForgeEvent } from '@specforge/shared';
import type { ChangeRow, EventQuery, QuestionRow, SyncResult } from './index-db.ts';

type Awaitable<T> = T | Promise<T>;

export interface IndexStatus {
  backend: 'sqlite' | 'postgres';
  state: 'ready' | 'stale' | 'unavailable';
  lastSyncedSeq: number;
}

/** 调用方必须 await；SQLite 可同步完成，网络后端使用真正的异步 IO。 */
export interface QueryIndex {
  sync(options?: { rebuild?: boolean }): Awaitable<SyncResult>;
  changes(filter?: { stage?: string }): Awaitable<ChangeRow[]>;
  questions(changeId: string, filter?: { status?: string; severity?: string }): Awaitable<QuestionRow[]>;
  events(query?: EventQuery): Awaitable<ForgeEvent[]>;
  status(): IndexStatus;
  close(): Awaitable<void>;
}
