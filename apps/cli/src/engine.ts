import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  acIdsOf,
  evaluateReview,
  evaluateSpec,
  evaluateTwin,
  evaluateUnderstanding,
  evaluateVerification,
  parseSpec,
  understandingBinding,
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

export function specBindingNow(store: Store, state: ChangeState): string | undefined {
  return evaluateAll(store, state).G2?.boundTo.value;
}
