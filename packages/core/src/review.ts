import type { ReviewRecord } from '@specforge/shared';
import type { ParsedSpec } from './spec.ts';
import type { ParsedTasks } from './tasks.ts';

export type ReviewDisposition = 'current' | 'superseded' | 'historical';

export interface ReviewFindingView {
  index: number;
  disposition: ReviewDisposition;
  finding: ReviewRecord['findings'][number];
  acId?: string;
  questionId?: string;
  acLink: 'exact' | 'ambiguous' | 'unknown' | 'none';
  questionLink: 'current-question' | 'unknown' | 'none';
}

export interface ReviewRecordView {
  seq: number;
  disposition: ReviewDisposition;
  record: ReviewRecord;
  coverageAcIds: string[];
  findings: ReviewFindingView[];
}

export interface ReviewClassification {
  records: ReviewRecordView[];
  latest: { agent?: number; human?: number };
}

export interface ReviewAcTraceRow {
  acId: string;
  spec: { file: string; requirementTitle: string; requirementLine: number; scenarioTitle: string; scenarioLine: number };
  occurrenceCount: number;
  ambiguous: boolean;
  tasks: { id: string; title: string; done: boolean; line: number }[];
  testFiles: string[];
  reviewSeqs: number[];
  findingRefs: { reviewSeq: number; findingIndex: number }[];
}

const AC_ID = /^AC-\d+$/;
const QUESTION_ID = /^Q-\d+$/;

/** The records array is the authoritative write order; timestamps are display data only. */
export function classifyReviewRecords(
  targetSha: string | undefined,
  records: ReviewRecord[],
  knownAcIds: string[],
  knownQuestionIds: string[],
): ReviewClassification {
  const counts = new Map<string, number>();
  for (const acId of knownAcIds) counts.set(acId, (counts.get(acId) ?? 0) + 1);
  const questions = new Set(knownQuestionIds);
  const latest: ReviewClassification['latest'] = {};
  if (targetSha) {
    records.forEach((record, index) => {
      if (record.sha === targetSha) latest[record.kind] = index + 1;
    });
  }
  return {
    latest,
    records: records.map((record, index) => {
      const seq = index + 1;
      const disposition: ReviewDisposition = !targetSha || record.sha !== targetSha
        ? 'historical'
        : latest[record.kind] === seq ? 'current' : 'superseded';
      const coverageAcIds = disposition === 'current' ? [...new Set(record.coverage.filter((entry) => counts.has(entry)))] : [];
      const findings = record.findings.map((finding, findingIndex): ReviewFindingView => {
        const acAnchor = disposition === 'current' && finding.anchor && AC_ID.test(finding.anchor) ? finding.anchor : undefined;
        const acId = acAnchor && counts.has(acAnchor) ? acAnchor : undefined;
        const questionId = finding.anchor && QUESTION_ID.test(finding.anchor) && questions.has(finding.anchor) ? finding.anchor : undefined;
        const occurrenceCount = acId ? counts.get(acId)! : 0;
        return {
          index: findingIndex + 1,
          disposition,
          finding,
          ...(acId ? { acId } : {}),
          ...(questionId ? { questionId } : {}),
          acLink: !acAnchor ? 'none'
            : !acId ? 'unknown' : occurrenceCount === 1 ? 'exact' : 'ambiguous',
          questionLink: !finding.anchor || !QUESTION_ID.test(finding.anchor) ? 'none'
            : questionId ? 'current-question' : 'unknown',
        };
      });
      return { seq, disposition, record, coverageAcIds, findings };
    }),
  };
}

/** Keep each scenario row distinct; repeated AC numbers are explicitly ambiguous. */
export function buildReviewAcTrace(
  specs: ParsedSpec[],
  tasks: ParsedTasks | undefined,
  testReferences: Map<string, string[]>,
  classification: ReviewClassification,
): ReviewAcTraceRow[] {
  const specsRows = specs.flatMap((spec) => spec.requirements.flatMap((requirement) => requirement.scenarios.flatMap((scenario) =>
    scenario.acId ? [{
      acId: scenario.acId,
      spec: { file: spec.file, requirementTitle: requirement.title, requirementLine: requirement.line,
        scenarioTitle: scenario.title, scenarioLine: scenario.line },
    }] : [],
  )));
  const counts = new Map<string, number>();
  for (const row of specsRows) counts.set(row.acId, (counts.get(row.acId) ?? 0) + 1);
  const links = new Map(Array.from(counts, ([acId, occurrenceCount]) => {
    const refs: Omit<ReviewAcTraceRow, 'acId' | 'spec'> = {
      occurrenceCount, ambiguous: occurrenceCount > 1, tasks: [],
      testFiles: [...new Set(testReferences.get(acId) ?? [])].sort(), reviewSeqs: [], findingRefs: [],
    };
    return [acId, refs];
  }));
  for (const { id, title, done, line, acRefs } of tasks?.tasks ?? []) {
    const task = { id, title, done, line };
    for (const acId of acRefs) links.get(acId)?.tasks.push(task);
  }
  for (const entry of classification.records) {
    if (entry.disposition !== 'current') continue;
    // Coverage entries refer to the number. Findings link to one unique scenario.
    for (const acId of entry.coverageAcIds) links.get(acId)?.reviewSeqs.push(entry.seq);
    for (const finding of entry.findings) {
      if (finding.acLink !== 'exact' || !finding.acId) continue;
      links.get(finding.acId)?.findingRefs.push({ reviewSeq: entry.seq, findingIndex: finding.index });
    }
  }
  return specsRows.map((row) => ({ ...row, ...links.get(row.acId)! }));
}
