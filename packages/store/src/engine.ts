import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acIdsOf,
  evaluateDesign,
  evaluateReview,
  evaluateSpec,
  evaluateTasks,
  evaluateTdd,
  evaluateTwin,
  evaluateUnderstanding,
  evaluateVerification,
  matchesAny,
  parseTestCount,
  parseDesign,
  parseSpec,
  parseTasks,
  unresolvedComments,
  understandingBinding,
  type ParsedDesign,
  type ParsedSpec,
} from '@specforge/core';
import { acCoverage, antiCheat, git, headSha, isAncestor, listFilesAt, readFileAt } from '@specforge/runner';
import type { GateEvaluation, GateId, VerificationEvidence } from '@specforge/shared';
import type { ChangeState, Store } from './store.ts';

/** 读取 OpenSpec 文件的来源：工作区，或某个 commit（路径均相对仓库根目录） */
export interface SourceTree {
  kind: 'worktree' | 'commit';
  /** commit 来源的 SHA */
  sha?: string;
  list(dir: string): string[];
  read(path: string): string | undefined;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function workTree(root: string): SourceTree {
  return {
    kind: 'worktree',
    list: (dir) => walk(join(root, dir)).map((f) => relative(root, f)),
    read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined),
  };
}

export function commitTree(root: string, sha: string): SourceTree {
  return { kind: 'commit', sha, list: (dir) => listFilesAt(root, sha, dir), read: (path) => readFileAt(root, sha, path) };
}

/** 进入实现阶段后，代码与证据都绑定 commit，门禁也按 HEAD 中的 OpenSpec 文件评估 */
export function factsTree(store: Store, state: ChangeState): SourceTree {
  return COMMITTED_STAGES.includes(state.change.stage) ? commitTree(store.root, headSha(store.root)) : workTree(store.root);
}

const COMMITTED_STAGES = ['implement', 'closing', 'delivered'];

const changeDir = (changeId: string) => `openspec/changes/${changeId}`;

export interface SpecFacts {
  specs: ParsedSpec[];
  sources: { path: string; text: string }[];
}

/** 读取 OpenSpec change 目录下的 proposal.md 与 specs/**\/spec.md */
export function readSpecFacts(store: Store, changeId: string, tree: SourceTree = workTree(store.root)): SpecFacts {
  const dir = changeDir(changeId);
  const files = [`${dir}/proposal.md`, ...tree.list(`${dir}/specs`).filter((f) => f.endsWith('spec.md'))].sort();
  const sources = files.flatMap((path) => {
    const text = tree.read(path);
    return text === undefined ? [] : [{ path, text }];
  });
  const specs = sources.filter((s) => s.path.endsWith('spec.md')).map((s) => parseSpec(s.path, s.text));
  return { specs, sources };
}

export interface DesignFacts {
  path: string;
  text: string;
  design?: ParsedDesign;
}

export function readDesignFacts(store: Store, changeId: string, tree: SourceTree = workTree(store.root)): DesignFacts {
  const path = `${changeDir(changeId)}/design.md`;
  const text = tree.read(path);
  if (text === undefined) return { path, text: '' };
  return { path, text, design: parseDesign(path, text) };
}

export function readTasksFacts(store: Store, changeId: string, tree: SourceTree = workTree(store.root)) {
  const path = `${changeDir(changeId)}/tasks.md`;
  const text = tree.read(path);
  return text === undefined ? undefined : parseTasks(path, text);
}

/** 进入实现阶段后，OpenSpec 目录中未提交的改动不参与评估，需要提示 */
export function uncommittedSpecChanges(store: Store, changeId: string): string[] {
  const out = git(store.root, ['status', '--porcelain', '--untracked-files=all', '--', changeDir(changeId)]);
  return out ? out.split('\n').map((l) => l.slice(3)) : [];
}

export type Evaluations = Partial<Record<GateId, GateEvaluation>>;

/** 此刻重新评估全部门禁（不使用任何缓存结果） */
export function evaluateAll(store: Store, state: ChangeState): Evaluations {
  const now = new Date().toISOString();
  const config = store.config();
  const { change, analysis, questions, reviews, approvals } = state;

  const unresolved = (t: 'spec' | 'design' | 'tasks') => unresolvedComments(state.comments ?? [], t).map((c) => c.id);
  const g1 = evaluateUnderstanding(analysis, questions, change.tier, now);
  const out: Evaluations = { G1: g1 };

  const tree = factsTree(store, state);
  const facts = readSpecFacts(store, change.id, tree);
  if (change.tier !== 'S') {
    out.G2 = evaluateSpec(
      {
        ...facts,
        questions,
        understandingBinding: understandingBinding(analysis, questions),
        approvals,
        tier: change.tier,
        unresolvedComments: unresolved('spec'),
      },
      now,
    );
  }

  if (change.tier !== 'S' && out.G2) {
    const design = readDesignFacts(store, change.id, tree);
    out.G3 = evaluateDesign(
      {
        design: design.design,
        text: design.text,
        acIds: acIdsOf(facts.specs),
        specBinding: out.G2.boundTo.value,
        approvals,
        tier: change.tier,
        protectedPaths: config.protectedPaths,
        unresolvedComments: unresolved('design'),
      },
      now,
    );
    out.G4 = evaluateTasks(
      {
        tasks: readTasksFacts(store, change.id, tree),
        acIds: acIdsOf(facts.specs),
        structureIds: design.design?.changes.map((c) => c.id) ?? [],
        designBinding: out.G3.boundTo.value,
        unresolvedComments: unresolved('tasks'),
      },
      now,
    );
  }

  if (change.stage === 'implement' || change.stage === 'closing' || change.stage === 'delivered') {
    const sha = headSha(store.root);
    if (change.tier !== 'S') {
      out.G5 = evaluateTdd(
        {
          configured: !!config.tdd?.command,
          tasks: readTasksFacts(store, change.id, tree),
          records: store.tddEvidence(change.id).map((evidence) => ({ evidence, reachable: isAncestor(store.root, evidence.sha, sha) })),
        },
        now,
      );
    }
    const acIds = acIdsOf(facts.specs);
    const cheat = antiCheat(store.root, change.baseSha, sha, config);
    const evidence = store.latestEvidence(change.id, sha);
    const baseEvidence = store.latestEvidence(change.id, change.baseSha);
    const step = config.testReport?.step ?? 'test';
    const count = (ev?: VerificationEvidence) => {
      const out = ev?.steps.find((s) => s.name === step)?.outputTail;
      return out === undefined ? undefined : parseTestCount(out, config.testReport?.pattern)?.total;
    };
    const a = evaluateVerification(
      {
        headSha: sha,
        requiredSteps: config.verify.map((s) => s.name),
        evidence,
        acIds,
        requireAc: change.tier !== 'S',
        acCoverage: acCoverage(store.root, sha, acIds, config.testGlobs),
        skipHits: cheat.skipHits,
        protectedChanges: cheat.protectedChanges,
        testCount: {
          step,
          head: count(evidence),
          baseEvidence: !!baseEvidence,
          base: count(baseEvidence),
          baseHasTests: listFilesAt(store.root, change.baseSha, '.').some((f) => matchesAny(f, config.testGlobs)),
        },
      },
      now,
    );
    const b = evaluateReview(sha, reviews, now);
    out.G6A = a;
    out.G6B = b;
    out.G6 = evaluateTwin(a, b, sha, now);
  }
  return out;
}

export function bindingNow(store: Store, state: ChangeState, gate: 'G2' | 'G3'): string | undefined {
  return evaluateAll(store, state)[gate]?.boundTo.value;
}
