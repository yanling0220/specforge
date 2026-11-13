import filesystem from 'node:fs';
import processes from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { addUser, createQuestion, emptyAnalysis, ForgeError, nextQuestionId, sha256 } from '@specforge/core';
import { headSha } from '@specforge/runner';
import { defaultConfig, Store } from '../../src/index.ts';

const [root, mode, label = 'worker', count = '1'] = process.argv.slice(2) as [string, string, string?, string?];
const actor = { name: 'admin', role: 'dev' as const };
const store = new Store(root);
process.send!({ type: 'ready' });
await once(process, 'message');

if (mode === 'hold') {
  await store.exclusive(async () => {
    process.send!({ type: 'locked' });
    await once(process, 'message');
  });
} else {
  if (mode.startsWith('crash') || mode === 'io-error') {
    const rename = filesystem.renameSync;
    filesystem.renameSync = (source, target) => {
      rename(source, target);
      if (String(target).endsWith(label)) {
        if (mode === 'io-error') throw new Error('injected write failure');
        process.kill(process.pid, 'SIGKILL');
      }
    };
    if (mode === 'crash-merge') {
      const execute = processes.execFileSync;
      processes.execFileSync = ((...args: Parameters<typeof execute>) => {
        const result = execute(...args);
        if (Array.isArray(args[1]) && args[1][0] === 'merge') process.kill(process.pid, 'SIGKILL');
        return result;
      }) as typeof execute;
    }
    syncBuiltinESMExports();
  }
  for (let index = 0; index < Number(count); index++) {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        if (mode === 'append') store.append({ type: label, actor, payload: { index } });
        else if (mode === 'mixed') {
          store.exclusive(() => {
            store.mutateUsers(actor, 'user.added', (registry) => addUser(registry, { name: `${label}-${index}`, roles: ['dev'] }, sha256('test-token'), actor, 'T'), {});
            store.mutate(label, actor, 'test.changed', (state) => ({ ...state, change: { ...state.change, title: `${label}-${index}` } }), () => ({}));
            store.saveEvidence(label, { id: `${label}-${index}`, sha: headSha(root), startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: [], host: { node: 'v', platform: 'p' } }, actor);
            store.append({ type: 'standalone', actor, payload: { label, index } });
          });
        } else if (mode === 'create') {
          store.create({ change: { id: `${label}-${index}`, title: label, stage: 'analysis', tier: 'S', baseSha: headSha(root), createdAt: 'T', createdBy: actor }, analysis: emptyAnalysis(defaultConfig()), questions: [], reviews: [], approvals: [] }, actor);
        } else if (mode === 'crash-evidence') {
          store.saveEvidence('a', { id: 'crashed', sha: headSha(root), startedAt: 'T', finishedAt: 'T', mainTreeDirty: false, steps: [], host: { node: 'v', platform: 'p' } }, actor);
        } else if (mode === 'crash-merge') {
          store.mergeImplementation(label, { type: 'implement.committed', actor, changeId: 'a', payload: { sha: label } });
        } else if (mode === 'artifact' || mode === 'crash-artifact') {
          store.writeArtifacts({ type: 'artifact.generated', actor, changeId: 'a', payload: {} }, { 'openspec/changes/a/design.md': 'new design\n' });
        } else {
          store.mutate('a', actor, 'question.raised', (state) => ({ ...state, questions: [...state.questions, createQuestion({ id: nextQuestionId(state.questions), question: `${label}-${index}`, category: '技术约束', severity: 'minor', raisedAtStage: 'analysis' }, store.config(), actor, 'T')] }), () => ({}));
        }
        break;
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === 'write_busy') || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
}
process.send!({ type: 'done' });
process.disconnect!();
