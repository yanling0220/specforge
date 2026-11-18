import type { HumanRole, Stage } from './index.ts';

/** 当前仍需人工决定的版本；这是只读投影，不是可直接提交的操作票据。 */
export type HumanDecision =
  | { kind: 'question-confirmation'; role: HumanRole; questionId: string; rev: number; answerHash: string }
  | { kind: 'spec-approval' | 'design-approval'; role: 'dev'; contentHash: string }
  | { kind: 'human-signoff'; role: 'dev'; sha: string };

export type InboxItem = HumanDecision & {
  id: string;
  changeId: string;
  changeTitle: string;
  stage: Stage;
};
