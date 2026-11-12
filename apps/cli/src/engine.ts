import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acIdsOf,
  evaluateDesign,
  evaluateReview,
  evaluateSpec,
  evaluateTasks,
  evaluateTwin,
  evaluateUnderstanding,
  evaluateVerification,
  parseDesign,
  parseSpec,
  parseTasks,
  understandingBinding,
  type ParsedDesign,
  type ParsedSpec,
} from '@specforge/core';
import { acCoverage, antiCheat, headSha } from '@specforge/runner';
import type { GateEvaluation, GateId } from '@specforge/shared';
import type { ChangeState, Store } from './store.ts';

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export interface SpecFacts {
  specs: ParsedSpec[];
  sources: { path: string; text: string }[];
}

/** 读取 OpenSpec change 目录下的 proposal.md 与 specs/**\/spec.md */
export function readSpecFacts(store: Store, changeId: string): SpecFacts {
  const dir = store.openspecChangeDir(changeId);
  const files = [join(dir, 'proposal.md'), ...walk(join(dir, 'specs')).filter((f) => f.endsWith('spec.md'))]
    .filter((f) => existsSync(f))
    .sort();
  const sources = files.map((f) => ({ path: relative(store.root, f), text: readFileSync(f, 'utf8') }));
  const specs = sources.filter((s) => s.path.endsWith('spec.md')).map((s) => parseSpec(s.path, s.text));
  return { specs, sources };
}

export interface DesignFacts {
  path: string;
  text: string;
  design?: ParsedDesign;
}

export function readDesignFacts(store: Store, changeId: string): DesignFacts {
  const file = join(store.openspecChangeDir(changeId), 'design.md');
  const path = relative(store.root, file);
  if (!existsSync(file)) return { path, text: '' };
  const text = readFileSync(file, 'utf8');
  return { path, text, design: parseDesign(path, text) };
}

export function readTasksFacts(store: Store, changeId: string) {
  const file = join(store.openspecChangeDir(changeId), 'tasks.md');
  return existsSync(file) ? parseTasks(relative(store.root, file), readFileSync(file, 'utf8')) : undefined;
}

export type Evaluations = Partial<Record<GateId, GateEvaluation>>;

/** 此刻重新评估全部门禁（不使用任何缓存结果） */
export function evaluateAll(store: Store, state: ChangeState): Evaluations {
  const now = new Date().toISOString();
  const config = store.config();
  const { change, analysis, questions, reviews, approvals } = state;

  const g1 = evaluateUnderstanding(analysis, questions, change.tier, now);
  const out: Evaluations = { G1: g1 };

  const facts = readSpecFacts(store, change.id);
  if (change.tier !== 'S') {
    out.G2 = evaluateSpec(
      {
        ...facts,
        questions,
        understandingBinding: understandingBinding(analysis, questions),
        approvals,
        tier: change.tier,
      },
      now,
    );
  }

  if (change.tier !== 'S' && out.G2) {
    const design = readDesignFacts(store, change.id);
    out.G3 = evaluateDesign(
      {
        design: design.design,
        text: design.text,
        acIds: acIdsOf(facts.specs),
        specBinding: out.G2.boundTo.value,
        approvals,
        tier: change.tier,
        protectedPaths: config.protectedPaths,
      },
      now,
    );
    out.G4 = evaluateTasks(
      {
        tasks: readTasksFacts(store, change.id),
        acIds: acIdsOf(facts.specs),
        structureIds: design.design?.changes.map((c) => c.id) ?? [],
        designBinding: out.G3.boundTo.value,
      },
      now,
    );
  }

  if (change.stage === 'implement' || change.stage === 'closing' || change.stage === 'delivered') {
    const sha = headSha(store.root);
    const acIds = acIdsOf(facts.specs);
    const cheat = antiCheat(store.root, change.baseSha, sha, config);
    const a = evaluateVerification(
      {
        headSha: sha,
        requiredSteps: config.verify.map((s) => s.name),
        evidence: store.latestEvidence(change.id, sha),
        acIds,
        requireAc: change.tier !== 'S',
        acCoverage: acCoverage(store.root, sha, acIds, config.testGlobs),
        skipHits: cheat.skipHits,
        protectedChanges: cheat.protectedChanges,
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
