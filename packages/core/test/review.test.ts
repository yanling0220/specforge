import { describe, expect, it } from 'vitest';
import type { ReviewRecord } from '@specforge/shared';
import { buildReviewAcTrace, classifyReviewRecords, parseSpec, parseTasks } from '../src/index.ts';

const record = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  kind: 'agent', sha: 'a'.repeat(40), verdict: 'pass', reviewer: { name: 'reviewer', role: 'agent' },
  at: '2026-01-01T00:00:00.000Z', coverage: ['AC-1', 'src/file.ts', 'AC-10'], findings: [], ...overrides,
});

describe('review history and AC trace', () => {
  it('classifies same-SHA records by write order, not timestamp, and keeps other SHAs historical', () => {
    const records = [
      record({ at: '2099-01-01T00:00:00.000Z' }),
      record({ at: '2020-01-01T00:00:00.000Z', verdict: 'fail' }),
      record({ sha: 'b'.repeat(40), verdict: 'pass' }),
      record({ kind: 'human', at: '2019-01-01T00:00:00.000Z' }),
    ];
    const result = classifyReviewRecords('a'.repeat(40), records, ['AC-1'], []);
    expect(result.latest).toEqual({ agent: 2, human: 4 });
    expect(result.records.map(({ disposition }) => disposition)).toEqual(['superseded', 'current', 'historical', 'current']);
    expect(result.records[1]!.coverageAcIds).toEqual(['AC-1']);
  });

  it('maps only exact current AC findings and known current-question references', () => {
    const review = record({ findings: [
      { severity: 'blocking', anchor: 'AC-1', text: 'current AC finding' },
      { severity: 'non-blocking', anchor: 'AC-9', text: 'unknown AC' },
      { severity: 'blocking', anchor: 'Q-2', text: 'question reference' },
      { severity: 'blocking', anchor: 'file.ts:12', text: 'free-form anchor' },
    ] });
    const result = classifyReviewRecords('a'.repeat(40), [review], ['AC-1'], ['Q-2']);
    expect(result.records[0]!.findings.map(({ acLink, questionLink }) => [acLink, questionLink])).toEqual([
      ['exact', 'none'], ['unknown', 'none'], ['none', 'current-question'], ['none', 'none'],
    ]);
    expect(result.records[0]!.findings[3]!.acId).toBeUndefined();
  });

  it('keeps duplicate scenarios distinct and does not attach shared AC evidence to either row', () => {
    const spec = parseSpec('openspec/changes/c/specs/x/spec.md', [
      '### Requirement: R', '#### Scenario: First [AC-1]', '#### Scenario: Second [AC-1]',
    ].join('\n'));
    const tasks = parseTasks('openspec/changes/c/tasks.md', '- [x] T-1 Task (AC-1)');
    const reviews = classifyReviewRecords('a'.repeat(40), [record({ findings: [
      { severity: 'non-blocking', anchor: 'AC-1', text: 'shared' },
    ] })], ['AC-1', 'AC-1'], []);
    const rows = buildReviewAcTrace([spec], tasks, new Map([['AC-1', ['test/a.test.ts']]]), reviews);
    expect(rows).toHaveLength(2);
    expect(rows.map(({ spec: { scenarioTitle }, ambiguous, tasks: refs, testFiles, reviewSeqs, findingRefs }) => ({
      scenarioTitle, ambiguous, taskCount: refs.length, testFiles, reviewSeqs, findingRefs,
    }))).toEqual([
      { scenarioTitle: 'First [AC-1]', ambiguous: true, taskCount: 1, testFiles: ['test/a.test.ts'], reviewSeqs: [1], findingRefs: [] },
      { scenarioTitle: 'Second [AC-1]', ambiguous: true, taskCount: 1, testFiles: ['test/a.test.ts'], reviewSeqs: [1], findingRefs: [] },
    ]);
  });
});
