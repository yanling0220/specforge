// 共享类型定义。字段含义见 docs/design.md。

export type Role = 'dev' | 'product' | 'agent';

export interface Actor {
  name: string;
  role: Role;
}

// ---------- 项目配置（宪法） ----------

export interface VerifyStep {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface ProjectConfig {
  version: 1;
  verify: VerifyStep[];
  /** 改动这些路径需要人工审批（glob，支持 * 和 **） */
  protectedPaths: string[];
  /** 用于 AC 覆盖检查的测试文件 glob */
  testGlobs: string[];
  /** diff 中新增这些正则即视为跳过测试 */
  skipPatterns: string[];
  /** 问题分类 → 需要确认的角色；未列出的分类使用 default */
  confirmPolicy: Record<string, Role[]> & { default: Role[] };
  /** 需求分析维度 */
  dimensions: string[];
  /** agent 后端配置；未配置时使用 Claude 默认值 */
  agents?: AgentsConfig;
}

/**
 * - claude：Claude Agent SDK
 * - deepseek：DeepSeek 的 Anthropic 兼容接口，同样运行在 Claude Agent SDK 上
 * - codex：OpenAI Codex SDK（只读沙箱 + 结构化输出）
 * - openai-compatible：引擎自带的最小 agent 循环，适用于任何 OpenAI 兼容接口
 */
export type AgentBackend = 'claude' | 'deepseek' | 'codex' | 'openai-compatible';

export type AgentRole = 'analyst' | 'reviewer' | 'implementer';

export interface AgentProfile {
  backend: AgentBackend;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns?: number;
  /** 单次运行的费用上限（美元）；仅 claude / deepseek 后端生效 */
  maxBudgetUsd?: number;
  /** 接口地址；claude 后端填 Anthropic 兼容地址，openai-compatible 填 OpenAI 兼容地址 */
  baseUrl?: string;
  /** 存放 API key 的环境变量名（只记录变量名，不在配置里写 key） */
  apiKeyEnv?: string;
  /** openai-compatible 的预设：deepseek / ollama；填了 baseUrl 则以 baseUrl 为准 */
  provider?: string;
}

export interface AgentsConfig {
  default?: AgentProfile;
  roles?: Partial<Record<AgentRole, AgentProfile>>;
}

// ---------- change ----------

export type Tier = 'S' | 'M' | 'L';

export type Stage = 'analysis' | 'spec' | 'design' | 'tasks' | 'implement' | 'closing' | 'delivered';

export interface Change {
  id: string;
  title: string;
  tier: Tier;
  stage: Stage;
  /** 创建 change 时的 HEAD，用作防作弊 diff 的基线 */
  baseSha: string;
  createdAt: string;
  createdBy: Actor;
}

// ---------- 需求分析 ----------

export interface Confirmation {
  role: Role;
  actor: Actor;
  at: string;
  /** 核对渠道：会议纪要、IM 链接等 */
  via?: string;
  /** 代录人；为空表示本人确认 */
  recordedBy?: Actor;
  note?: string;
}

export interface Restatement {
  text: string;
  hash: string;
  confirmation?: Confirmation & { hash: string };
}

export interface RequirementNode {
  id: string;
  parentId?: string;
  kind: 'goal' | 'feature' | 'scenario';
  title: string;
}

export type AssumptionStatus = 'pending' | 'accepted' | 'rejected';

export interface Assumption {
  id: string;
  text: string;
  status: AssumptionStatus;
  decidedBy?: Actor;
  decidedAt?: string;
  note?: string;
}

export type DimensionStatus = 'pending' | 'covered' | 'question' | 'na';

export interface DimensionCoverage {
  dimension: string;
  status: DimensionStatus;
  reason?: string;
  questionIds?: string[];
}

export interface Analysis {
  restatement?: Restatement;
  nodes: RequirementNode[];
  assumptions: Assumption[];
  dimensions: DimensionCoverage[];
}

// ---------- 问题节点 ----------

export type Severity = 'blocking' | 'important' | 'minor';

export type QuestionStatus = 'open' | 'drafted' | 'confirmed' | 'deferred' | 'invalidated';

export interface QuestionOption {
  id: string;
  text: string;
  impact?: string;
  recommended?: boolean;
}

export type RevisionState = 'pending' | 'confirmed' | 'rejected' | 'superseded';

export interface AnswerRevision {
  rev: number;
  text: string;
  optionId?: string;
  /** 修订原因；取代已确认答案时必填 */
  reason?: string;
  proposedBy: Actor;
  proposedAt: string;
  state: RevisionState;
  confirmations: Confirmation[];
  rejection?: { actor: Actor; at: string; note: string };
  /** 答案内容哈希（text + optionId），写入事件日志 */
  hash: string;
}

export interface Question {
  id: string;
  nodeId?: string;
  category: string;
  severity: Severity;
  question: string;
  why?: string;
  evidence?: string;
  options: QuestionOption[];
  defaultOptionId?: string;
  requiredRoles: Role[];
  status: QuestionStatus;
  dependsOn: string[];
  raisedAtStage: Stage;
  raisedBy: Actor;
  raisedAt: string;
  revisions: AnswerRevision[];
  /** 推迟或作废的原因 */
  closure?: { kind: 'deferred' | 'invalidated'; actor: Actor; at: string; reason: string };
}

// ---------- 门禁 ----------

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G6A' | 'G6B' | 'G6';

export type GateStatus = 'passed' | 'failed' | 'unverified';

export interface CheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface GateEvaluation {
  gate: GateId;
  status: GateStatus;
  checks: CheckResult[];
  /** 评估时绑定的对象：内容哈希或 commit SHA */
  boundTo: { kind: 'content' | 'commit'; value: string };
  evaluatedAt: string;
}

// ---------- 证据与审查 ----------

export interface StepEvidence {
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  outputHash: string;
}

export interface VerificationEvidence {
  id: string;
  sha: string;
  startedAt: string;
  finishedAt: string;
  mainTreeDirty: boolean;
  steps: StepEvidence[];
  host: { node: string; platform: string };
}

export type FindingKind = 'missing' | 'regression' | 'unplanned';

export interface ReviewFinding {
  severity: 'blocking' | 'non-blocking';
  kind?: FindingKind;
  /** 锚点：AC 编号、任务编号或设计条目 */
  anchor?: string;
  text: string;
}

export interface ReviewRecord {
  kind: 'agent' | 'human';
  sha: string;
  verdict: 'pass' | 'fail';
  reviewer: Actor;
  at: string;
  /** 覆盖范围回执：审查了哪些 AC / 文件 */
  coverage: string[];
  findings: ReviewFinding[];
  note?: string;
}

/** 人工审批，绑定被审批内容的哈希 */
export interface Approval {
  target: 'spec' | 'design';
  hash: string;
  actor: Actor;
  at: string;
  note?: string;
}

// ---------- 事件日志 ----------

export interface EventInput {
  type: string;
  actor: Actor;
  changeId?: string;
  payload: Record<string, unknown>;
  stateHash?: string;
}

export interface ForgeEvent extends EventInput {
  seq: number;
  at: string;
  prevHash: string;
  hash: string;
}
