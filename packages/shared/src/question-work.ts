import type { HumanRole, Question, Role, Severity } from './index.ts';

export const QUESTION_WORK_STATUSES = ['answer', 'revise', 'confirm', 'waiting'] as const;
export type QuestionWorkStatus = typeof QUESTION_WORK_STATUSES[number];
export type QuestionWorkAction = 'submit-answer' | 'confirm' | 'reject' | 'record' | 'defer' | 'invalidate';

export interface QuestionWorkItem {
  changeId: string;
  changeTitle: string;
  questionId: string;
  question: string;
  severity: Severity;
  raisedAt: string;
  status: QuestionWorkStatus;
  requiredRoles: Role[];
  missingRoles: Role[];
  answer?: { rev: number; text: string; rejection?: string };
}

export interface QuestionWorkPage {
  role: HumanRole;
  counts: Record<QuestionWorkStatus, number>;
  items: QuestionWorkItem[];
  nextCursor?: string;
}

export interface QuestionWorkDetail {
  changeId: string;
  changeTitle: string;
  role: HumanRole;
  question: Question;
  questionVersion: string;
  status?: QuestionWorkStatus;
  missingRoles: Role[];
  actions: QuestionWorkAction[];
  delivered: boolean;
  draftScope: string;
}

export type AnswerDraftInput = { reason?: string; via?: string } & (
  | { mode: 'free'; text: string; optionId?: string }
  | { mode: 'option'; optionId: string; supplement?: string }
);
