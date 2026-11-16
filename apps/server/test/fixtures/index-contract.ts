import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorLog, type Store } from '@specforge/store';
import { readLogAnchors } from '@specforge/runner';
import type { QueryIndex } from '../../src/query-index.ts';
import { indexActor, indexProject, indexQuestion } from './index-project.ts';

export function sourceFiles(store: Store): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[relative(store.root, file)] = readFileSync(file, 'utf8');
    }
  };
  visit(store.path());
  return files;
}

/** 同一组行为用例供 SQLite、注入传输的 Postgres 和专用真实测试库执行。 */
export function indexContract(label: string, factory: (store: Store, id: string) => Promise<QueryIndex>): void {
  describe(label, () => {
    const stores: Store[] = [];
    const indexes: QueryIndex[] = [];
    const project = (label?: string) => { const store = indexProject(label); stores.push(store); return store; };
    const open = async (store: Store, id = 'a') => { const index = await factory(store, id); indexes.push(index); return index; };
    afterEach(async () => {
      await Promise.all(indexes.splice(0).map((index) => index.close()));
      stores.splice(0).forEach((store) => rmSync(store.root, { recursive: true, force: true }));
    });

    it('首次、增量与空同步；过滤、问题自然顺序及事件分页', async () => {
      const store = project();
      const index = await open(store);
      expect(await index.sync()).toMatchObject({ changes: ['same', 'second'], rebuilt: false });
      indexQuestion(store, 'same', 'Q-10');
      indexQuestion(store, 'same', 'Q-2', 'minor');
      indexQuestion(store, 'second');
      expect(await index.sync()).toMatchObject({ changes: ['same', 'second'], rebuilt: false });
      expect((await index.changes({ stage: 'analysis' })).map((row) => row.id)).toEqual(['same', 'second']);
      expect(await index.changes({ stage: 'delivered' })).toEqual([]);
      expect((await index.questions('same')).map((row) => row.id)).toEqual(['Q-2', 'Q-10']);
      expect((await index.questions('same', { severity: 'minor', status: 'open' })).map((row) => row.id)).toEqual(['Q-2']);
      expect((await index.events({ changeId: 'same', type: 'question.raised', after: 2, limit: 1 })).map((event) => event.seq)).toEqual([3]);
      expect((await index.events({ after: 3, limit: 1 })).map((event) => event.seq)).toEqual([4]);
      expect(await index.sync()).toMatchObject({ changes: [], events: [] });
      expect(index.status()).toMatchObject({ state: 'ready', lastSyncedSeq: 5 });
    });

    it('同名 change / question / seq 隔离；重建一个项目不删除另一个', async () => {
      const a = project('A'); const b = project('B');
      indexQuestion(a); indexQuestion(b);
      const first = await open(a, 'a'); const second = await open(b, 'b');
      await first.sync(); await second.sync();
      const before = { changes: await second.changes(), questions: await second.questions('same'), events: await second.events() };
      a.mutate('same', indexActor, 'changed', (state) => ({ ...state, change: { ...state.change, title: 'A changed' } }), () => ({}));
      await first.sync({ rebuild: true });
      expect((await first.changes())[0]?.title).toBe('A changed');
      expect({ changes: await second.changes(), questions: await second.questions('same'), events: await second.events() }).toEqual(before);
      expect((await first.events())[0]?.seq).toBe((await second.events())[0]?.seq);
    });

    it('日志截断与同长度改写均触发项目级重建；空日志可再次增量同步', async () => {
      const store = project(); const index = await open(store);
      const original = readFileSync(store.path('events.jsonl'), 'utf8');
      indexQuestion(store); await index.sync();
      const complete = readFileSync(store.path('events.jsonl'), 'utf8');
      writeFileSync(store.path('events.jsonl'), original);
      expect(await index.sync()).toMatchObject({ rebuilt: true });
      expect(await index.events()).toHaveLength(2);
      const events = store.events(); events.at(-1)!.hash = 'rewritten';
      writeFileSync(store.path('events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      expect(await index.sync()).toMatchObject({ rebuilt: true });
      writeFileSync(store.path('events.jsonl'), '');
      expect(await index.sync()).toMatchObject({ rebuilt: true });
      expect(await index.events()).toEqual([]);
      writeFileSync(store.path('events.jsonl'), complete);
      expect((await index.sync()).events.map((event) => event.seq)).toEqual([1, 2, 3]);
    });

    it('重建读取失败后，原事件、列表及游标在同一事务中保留', async () => {
      const store = project(); const index = await open(store);
      await index.sync();
      const before = await index.events();
      const file = join(store.changeDir('same'), 'questions.json');
      const source = readFileSync(file, 'utf8');
      writeFileSync(file, 'broken');
      await expect(Promise.resolve().then(() => index.sync({ rebuild: true }))).rejects.toThrow();
      expect(index.status()).toMatchObject({ state: 'stale', lastSyncedSeq: 2 });
      writeFileSync(file, source);
      expect(await index.sync()).toMatchObject({ events: [], changes: [] });
      expect(await index.events()).toEqual(before);
      expect(await index.changes()).toHaveLength(2);
    });

    it('SQLite → 新后端 → SQLite 重建不修改源文件、事件哈希或可信锚定', async () => {
      const store = project(); indexQuestion(store); anchorLog(store);
      const before = sourceFiles(store); const anchors = readLogAnchors(store.root);
      const index = await open(store); await index.sync({ rebuild: true });
      const { ForgeIndex } = await import('../../src/index-db.ts');
      const sqlite = new ForgeIndex(store); indexes.push(sqlite); sqlite.sync({ rebuild: true });
      expect(await index.changes()).toEqual(sqlite.changes());
      expect(await index.questions('same')).toEqual(sqlite.questions('same'));
      expect(await index.events()).toEqual(sqlite.events());
      expect(sourceFiles(store)).toEqual(before);
      expect(readLogAnchors(store.root)).toEqual(anchors);
    });
  });
}
