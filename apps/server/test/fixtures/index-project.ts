import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestion, emptyAnalysis } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { defaultConfig, Store } from '@specforge/store';

export const indexActor = { name: 'dev', role: 'dev' as const };

export function indexProject(label = '示例'): Store {
  const root = mkdtempSync(join(tmpdir(), 'sf-index-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'init');
  mkdirSync(join(root, '.specforge', 'changes'), { recursive: true });
  writeFileSync(join(root, '.specforge', 'config.json'), JSON.stringify(defaultConfig()));
  const store = new Store(root);
  for (const id of ['same', 'second']) store.create({
    change: { id, title: `${label} ${id}`, tier: 'M', stage: 'analysis', baseSha: headSha(root), createdAt: 'T', createdBy: indexActor },
    analysis: emptyAnalysis(defaultConfig()), questions: [], reviews: [], approvals: [],
  }, indexActor);
  return store;
}

export function indexQuestion(store: Store, changeId = 'same', id = 'Q-1', severity: 'blocking' | 'minor' = 'blocking'): void {
  store.mutate(changeId, indexActor, 'question.raised', (state) => ({ ...state, questions: [...state.questions, createQuestion({ id, category: '业务规则', question: id, severity, raisedAtStage: 'analysis' }, store.config(), indexActor, 'T')] }), () => ({ questionId: id }));
}
