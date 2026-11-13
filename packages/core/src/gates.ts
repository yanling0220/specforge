import type {
  Analysis,
  Approval,
  CheckResult,
  GateEvaluation,
  GateId,
  Question,
  ReviewRecord,
  StepEvidence,
  TddEvidence,
  Tier,
  VerificationEvidence,
} from '@specforge/shared';
import { hashOf } from './hash.ts';
import { isResolved, missingRoles } from './questions.ts';
import { pathsIn, type ParsedDesign } from './design.ts';
import { matchesAny } from './policy.ts';
import { findCycles, taskStructure, type ParsedTasks } from './tasks.ts';
import { acIdsOf, questionRefsIn, type ParsedSpec } from './spec.ts';

// 门禁评估都是纯函数：输入当前事实，输出逐项检查结果。
// 没有任何检查项、或任一项不通过，都不算 passed（P1 默认未验证）。

function evaluation(
  gate: GateId,
  checks: CheckResult[],
  boundTo: GateEvaluation['boundTo'],
  now: string,
): GateEvaluation {
  const status = checks.length > 0 && checks.every((c) => c.passed) ? 'passed' : 'failed';
  return { gate, status, checks, boundTo, evaluatedAt: now };
}

function check(id: string, label: string, failures: string[]): CheckResult {
  return { id, label, passed: failures.length === 0, detail: failures.length ? failures.join('；') : undefined };
}

/** 评估结果在当前绑定对象下是否仍然有效（P4 内容一改就失效） */
export function isStillValid(ev: GateEvaluation | undefined, currentBinding: string): boolean {
  return !!ev && ev.status === 'passed' && ev.boundTo.value === currentBinding;
}

// ---------------- G1 理解门 ----------------

export function understandingBinding(analysis: Analysis, questions: Question[]): string {
  return hashOf({ analysis, questions });
}

export function evaluateUnderstanding(
  analysis: Analysis,
  questions: Question[],
  tier: Tier,
  now: string,
): GateEvaluation {
  const checks: CheckResult[] = [];
  const r = analysis.restatement;

  checks.push(
    check('restatement', '需求复述已确认，且确认后未被修改', [
      ...(!r ? ['还没有需求复述'] : []),
      ...(r && !r.confirmation ? ['复述尚未确认'] : []),
      ...(r?.confirmation && r.confirmation.hash !== r.hash ? ['复述在确认后被修改，需要重新确认'] : []),
    ]),
  );

  const describe = (q: Question) =>
    q.status === 'drafted' ? `${q.id}（待 ${missingRoles(q).join('、')} 确认）` : `${q.id}（${q.status}）`;
  const unresolved = (sev: Question['severity'], ok: (q: Question) => boolean) =>
    questions.filter((q) => q.severity === sev && !ok(q)).map(describe);

  checks.push(
    check('blocking', '所有阻塞问题已确认', unresolved('blocking', (q) => q.status === 'confirmed' || q.status === 'invalidated')),
  );

  if (tier !== 'S') {
    checks.push(
      check('important', '所有重要问题已确认', unresolved('important', (q) => q.status === 'confirmed' || q.status === 'invalidated')),
    );
    checks.push(check('minor', '所有次要问题已确认、推迟或作废', unresolved('minor', isResolved)));
    checks.push(
      check(
        'assumptions',
        '所有假设已确认或否决',
        analysis.assumptions.filter((a) => a.status === 'pending').map((a) => `${a.id} 待决定`),
      ),
    );
    const qIds = new Set(questions.map((q) => q.id));
    checks.push(
      check(
        'dimensions',
        '每个分析维度都有结论',
        analysis.dimensions.flatMap((d) => {
          if (d.status === 'pending') return [`「${d.dimension}」未分析`];
          if (d.status === 'na' && !d.reason) return [`「${d.dimension}」标记不适用但没有原因`];
          const dangling = (d.questionIds ?? []).filter((id) => !qIds.has(id));
          return dangling.length ? [`「${d.dimension}」引用了不存在的问题 ${dangling.join(',')}`] : [];
        }),
      ),
    );
  }

  return evaluation('G1', checks, { kind: 'content', value: understandingBinding(analysis, questions) }, now);
}

// ---------------- G2 规格门 ----------------

export interface SpecInputs {
  specs: ParsedSpec[];
  /** 所有 spec.md 与 proposal.md 的原文，按路径排序，用于计算绑定哈希和问题引用 */
  sources: { path: string; text: string }[];
  questions: Question[];
  understandingBinding: string;
  approvals: Approval[];
  tier: Tier;
}

export function specBinding(inputs: Pick<SpecInputs, 'sources' | 'understandingBinding'>): string {
  return hashOf({ sources: inputs.sources, upstream: inputs.understandingBinding });
}

export function evaluateSpec(inputs: SpecInputs, now: string): GateEvaluation {
  const checks: CheckResult[] = [];
  const scenarios = inputs.specs.flatMap((s) =>
    s.requirements.flatMap((r) => r.scenarios.map((sc) => ({ file: s.file, req: r.title, ...sc }))),
  );

  checks.push(check('has-scenarios', '至少有一个 Scenario', scenarios.length ? [] : ['未找到任何 Scenario']));
  checks.push(
    check(
      'ac-ids',
      '每个 Scenario 都有 AC 编号',
      scenarios.filter((s) => !s.acId).map((s) => `${s.file}:${s.line}「${s.title}」`),
    ),
  );
  const ids = acIdsOf(inputs.specs);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  checks.push(check('ac-unique', 'AC 编号不重复', dup.map((id) => `${id} 重复`)));

  const referenced = questionRefsIn(inputs.sources.map((s) => s.text).join('\n'));
  checks.push(
    check(
      'questions-traced',
      '每个已确认的问题都被 spec 或 proposal 引用',
      inputs.questions.filter((q) => q.status === 'confirmed' && !referenced.has(q.id)).map((q) => `${q.id} 未被引用`),
    ),
  );

  const binding = specBinding(inputs);
  if (inputs.tier !== 'S') {
    const approved = inputs.approvals.some((a) => a.target === 'spec' && a.hash === binding);
    checks.push(check('approved', '当前版本的 spec 已获人工审批', approved ? [] : ['当前 spec 版本未审批（或审批后内容有变化）']));
  }

  return evaluation('G2', checks, { kind: 'content', value: binding }, now);
}

// ---------------- G3 方案门 ----------------

export interface DesignInputs {
  design?: ParsedDesign;
  /** design.md 原文，用于计算绑定哈希 */
  text: string;
  acIds: string[];
  specBinding: string;
  approvals: Approval[];
  tier: Tier;
  protectedPaths: string[];
}

export function designBinding(inputs: Pick<DesignInputs, 'text' | 'specBinding'>): string {
  return hashOf({ design: inputs.text, upstream: inputs.specBinding });
}

/** L 档，或结构变更涉及受保护路径时，方案需要人工审批 */
export function designNeedsApproval(inputs: Pick<DesignInputs, 'design' | 'tier' | 'protectedPaths'>): { required: boolean; protectedHits: string[] } {
  const hits = (inputs.design?.changes ?? []).flatMap((c) => pathsIn(c.text).filter((p) => matchesAny(p, inputs.protectedPaths)).map((p) => `${c.id} ${p}`));
  return { required: inputs.tier === 'L' || hits.length > 0, protectedHits: hits };
}

export function evaluateDesign(inputs: DesignInputs, now: string): GateEvaluation {
  const d = inputs.design;
  const checks: CheckResult[] = [check('exists', '存在 design.md', d ? [] : ['未找到 openspec/changes/<id>/design.md'])];
  if (d) {
    checks.push(
      check('ac-covered', '方案覆盖全部 AC', inputs.acIds.length ? inputs.acIds.filter((id) => !d.acRefs.has(id)).map((id) => `${id} 未在方案中说明`) : ['spec 中没有 AC']),
    );
    const unknown = [...d.acRefs].filter((id) => !inputs.acIds.includes(id));
    checks.push(check('ac-known', '方案引用的 AC 都存在于 spec', unknown.map((id) => `${id} 不在 spec 中`)));
    const ids = d.changes.map((c) => c.id);
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    checks.push(
      check('structure', '有结构变更清单（或明确声明无结构变更）', [
        ...(!d.hasStructureSection ? ['缺少「## 结构变更」一节'] : []),
        ...(d.hasStructureSection && !d.changes.length && !d.noneReason ? ['结构变更清单为空；没有结构变更请写「- 无：<原因>」'] : []),
        ...(d.changes.length && d.noneReason ? ['同时列出了结构变更和「无」'] : []),
        ...dup.map((id) => `${id} 重复`),
        ...d.malformed.map((m) => `第 ${m.line} 行格式应为「- [S-n] …」：${m.text}`),
      ]),
    );
  }
  const binding = designBinding(inputs);
  const { required, protectedHits } = designNeedsApproval(inputs);
  if (required) {
    const approved = inputs.approvals.some((a) => a.target === 'design' && a.hash === binding);
    const why = inputs.tier === 'L' ? 'L 档' : `涉及受保护路径：${protectedHits.join('、')}`;
    checks.push(check('approved', `当前版本的方案已获人工审批（${why}）`, approved ? [] : ['当前方案版本未审批（或审批后内容有变化）']));
  }
  return evaluation('G3', checks, { kind: 'content', value: binding }, now);
}

// ---------------- G4 任务门 ----------------

export interface TasksInputs {
  tasks?: ParsedTasks;
  acIds: string[];
  /** design.md 中的结构变更编号 */
  structureIds: string[];
  designBinding: string;
}

/** 绑定任务结构而非原文：勾选进度不会让 G4 失效 */
export function tasksBinding(inputs: Pick<TasksInputs, 'tasks' | 'designBinding'>): string {
  return hashOf({ tasks: inputs.tasks ? taskStructure(inputs.tasks) : null, upstream: inputs.designBinding });
}

export function evaluateTasks(inputs: TasksInputs, now: string): GateEvaluation {
  const t = inputs.tasks;
  const checks: CheckResult[] = [check('exists', '存在 tasks.md 且至少有一个任务', t?.tasks.length ? [] : ['未找到任务（格式：- [ ] T-1 标题（AC-1, S-1）依赖 T-0）'])];
  if (t?.tasks.length) {
    const ids = t.tasks.map((x) => x.id);
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    checks.push(
      check('format', '每个任务都有唯一的 T-n 编号', [
        ...dup.map((id) => `${id} 重复`),
        ...t.malformed.map((m) => `第 ${m.line} 行缺少 T-n 编号：${m.text}`),
      ]),
    );
    checks.push(check('task-ac', '每个任务都关联至少一个 AC', t.tasks.filter((x) => !x.acRefs.length).map((x) => `${x.id} 没有关联 AC`)));
    checks.push(
      check('refs-known', '引用的 AC / 结构变更都存在', [
        ...t.tasks.flatMap((x) => x.acRefs.filter((a) => !inputs.acIds.includes(a)).map((a) => `${x.id} 引用了不存在的 ${a}`)),
        ...t.tasks.flatMap((x) => x.structureRefs.filter((s) => !inputs.structureIds.includes(s)).map((s) => `${x.id} 引用了不存在的 ${s}`)),
      ]),
    );
    const coveredAc = new Set(t.tasks.flatMap((x) => x.acRefs));
    checks.push(check('ac-covered', '每个 AC 都有任务负责', inputs.acIds.filter((a) => !coveredAc.has(a)).map((a) => `${a} 没有任务`)));
    const coveredS = new Set(t.tasks.flatMap((x) => x.structureRefs));
    checks.push(check('structure-covered', '每个结构变更都有任务负责', inputs.structureIds.filter((s) => !coveredS.has(s)).map((s) => `${s} 没有任务`)));
    checks.push(
      check('deps', '依赖都存在且无环', [
        ...t.tasks.flatMap((x) => x.dependsOn.filter((d) => d === x.id).map(() => `${x.id} 依赖自己`)),
        ...t.tasks.flatMap((x) => x.dependsOn.filter((d) => d !== x.id && !ids.includes(d)).map((d) => `${x.id} 依赖不存在的 ${d}`)),
        ...findCycles(t.tasks.map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== x.id) }))).map((c) => `依赖环：${c.join(' → ')}`),
      ]),
    );
  }
  return evaluation('G4', checks, { kind: 'content', value: tasksBinding(inputs) }, now);
}

// ---------------- G5 TDD 门 ----------------

function stepFailure(label: string, s: StepEvidence | undefined): string | undefined {
  if (!s) return `${label} 未执行`;
  if (s.timedOut) return `${label} 超时`;
  return s.exitCode === 0 ? undefined : `${label} 退出码 ${s.exitCode}`;
}

const present = (xs: (string | undefined)[]): string[] => xs.filter((x): x is string => !!x);

/** 单次任务尝试的 TDD 检查：有新测试；新测试在 base 上失败（RED）；在任务 commit 上通过（GREEN） */
export function tddAttemptChecks(ev: TddEvidence): CheckResult[] {
  const redSetup = ev.red.setup && stepFailure('RED 准备命令', ev.red.setup);
  const red = ev.red.test;
  return [
    check('tests-changed', '任务新增或修改了测试', ev.testFiles.length ? [] : ['没有新增或修改测试文件']),
    check(
      'red',
      '新测试在实现前失败（RED）',
      redSetup
        ? [redSetup]
        : present([
            !red ? 'RED 未执行' : undefined,
            red?.timedOut ? 'RED 超时，不能作为失败证据' : undefined,
            red && !red.timedOut && red.exitCode === 0 ? '新测试在实现前就通过了，没有证明它能发现问题' : undefined,
          ]),
    ),
    check(
      'green',
      '新测试在实现后通过（GREEN）',
      present([ev.green.setup && stepFailure('GREEN 准备命令', ev.green.setup), stepFailure('GREEN', ev.green.test)]),
    ),
  ];
}

export function tddAttemptPassed(ev: TddEvidence): boolean {
  return tddAttemptChecks(ev).every((c) => c.passed);
}

export interface TddInputs {
  /** 未配置 tdd.command 时 G5 不通过 */
  configured: boolean;
  tasks?: ParsedTasks;
  /** 引擎记录的 TDD 证据；reachable 表示其 commit 在当前 HEAD 的历史中 */
  records: { evidence: TddEvidence; reachable: boolean }[];
}

/** 每个任务都必须有一次通过的 TDD 尝试，且该尝试的 commit 仍在当前历史中 */
export function evaluateTdd(inputs: TddInputs, now: string): GateEvaluation {
  const tasks = inputs.tasks?.tasks ?? [];
  const accepted = new Map<string, TddEvidence>();
  for (const r of inputs.records) {
    if (r.reachable && tddAttemptPassed(r.evidence)) accepted.set(r.evidence.taskId, r.evidence);
  }
  const checks: CheckResult[] = [
    check('configured', '已配置只跑指定测试的命令（tdd.command）', inputs.configured ? [] : ['.specforge/config.json 缺少 tdd.command']),
    check('tasks-done', '所有任务已完成', [
      ...(!tasks.length ? ['没有任务'] : []),
      ...tasks.filter((t) => !t.done).map((t) => `${t.id} 未完成`),
    ]),
    check(
      'red-green',
      '每个任务都有先红后绿的引擎证据（commit 在当前历史中）',
      tasks.length
        ? tasks.flatMap((t) => {
            if (accepted.has(t.id)) return [];
            const own = inputs.records.filter((r) => r.evidence.taskId === t.id);
            if (!own.length) return [`${t.id} 没有 TDD 证据`];
            if (!own.some((r) => r.reachable)) return [`${t.id} 的 TDD 证据所在 commit 已不在当前历史中`];
            const last = own.filter((r) => r.reachable).at(-1)!.evidence;
            return [`${t.id}：${tddAttemptChecks(last).filter((c) => !c.passed).map((c) => c.detail).join('；')}`];
          })
        : ['没有任务'],
    ),
  ];
  const binding = hashOf(tasks.map((t) => ({ task: t.id, evidence: accepted.get(t.id)?.id ?? null, sha: accepted.get(t.id)?.sha ?? null })));
  return evaluation('G5', checks, { kind: 'content', value: binding }, now);
}

// ---------------- G6 双子门禁 ----------------

export interface VerificationInputs {
  headSha: string;
  requiredSteps: string[];
  evidence?: VerificationEvidence;
  acIds: string[];
  /** S 档没有 spec，不要求 AC 覆盖 */
  requireAc: boolean;
  /** AC 编号 → 在该 commit 中引用它的测试文件 */
  acCoverage: Record<string, string[]>;
  skipHits: { file: string; line: string }[];
  protectedChanges: string[];
  /** 测试数量不得下降（T3.6）；不提供时不检查 */
  testCount?: TestCountInputs;
}

export interface TestCountInputs {
  step: string;
  /** 当前 commit 解析出的测试总数；undefined 表示无证据或无法解析 */
  head?: number;
  /** 是否有基线 commit 的验证证据 */
  baseEvidence: boolean;
  base?: number;
  /** 基线 commit 中是否有测试文件；没有时基线视为 0 */
  baseHasTests: boolean;
}

function testCountFailures(t: TestCountInputs, hasHeadEvidence: boolean): string[] {
  if (!hasHeadEvidence) return ['无证据'];
  if (t.head === undefined) return [`无法从 ${t.step} 步骤的输出解析测试数量（可在 testReport.pattern 中配置正则）`];
  if (!t.baseEvidence) return ['没有基线 commit 的验证证据，请运行 sf verify（会同时验证基线）'];
  const base = t.base ?? (t.baseHasTests ? undefined : 0);
  if (base === undefined) return [`无法从基线 commit 的 ${t.step} 步骤输出解析测试数量`];
  return t.head < base ? [`测试数量从 ${base} 降到 ${t.head}`] : [];
}

export function evaluateVerification(inputs: VerificationInputs, now: string): GateEvaluation {
  const ev = inputs.evidence;
  const checks: CheckResult[] = [];
  checks.push(
    check('evidence', '存在针对当前 commit 的引擎验证证据', [
      ...(!ev ? [`没有 ${inputs.headSha.slice(0, 7)} 的验证证据，请运行 sf verify`] : []),
      ...(ev && ev.sha !== inputs.headSha ? [`证据属于 ${ev.sha.slice(0, 7)}，当前是 ${inputs.headSha.slice(0, 7)}`] : []),
    ]),
  );
  const steps = ev && ev.sha === inputs.headSha ? ev.steps : [];
  checks.push(
    check(
      'steps',
      '所有验证步骤通过',
      ev
        ? inputs.requiredSteps.flatMap((name) => {
            const s = steps.find((x) => x.name === name);
            if (!s) return [`${name} 未执行`];
            if (s.timedOut) return [`${name} 超时`];
            return s.exitCode === 0 ? [] : [`${name} 退出码 ${s.exitCode}`];
          })
        : ['无证据'],
    ),
  );
  if (inputs.requireAc || inputs.acIds.length > 0) {
    checks.push(
      check(
        'ac-coverage',
        '每个 AC 都有对应测试',
        inputs.acIds.length === 0
          ? ['spec 中没有 AC']
          : inputs.acIds.filter((id) => !inputs.acCoverage[id]?.length).map((id) => `${id} 没有测试引用`),
      ),
    );
  }
  checks.push(
    check(
      'no-skips',
      '没有新增跳过测试的标记',
      inputs.skipHits.map((h) => `${h.file}: ${h.line}`),
    ),
  );
  checks.push(
    check('protected', '没有改动受保护路径', inputs.protectedChanges.map((p) => `${p}（需要人工审批）`)),
  );
  if (inputs.testCount) {
    const t = inputs.testCount;
    const failures = testCountFailures(t, !!ev && ev.sha === inputs.headSha);
    checks.push({ ...check('test-count', '测试数量没有下降', failures), ...(failures.length ? {} : { detail: `基线 ${t.base ?? 0} → 当前 ${t.head}` }) });
  }
  return evaluation('G6A', checks, { kind: 'commit', value: inputs.headSha }, now);
}

export function evaluateReview(headSha: string, reviews: ReviewRecord[], now: string): GateEvaluation {
  const atHead = reviews.filter((r) => r.sha === headSha);
  const latest = (kind: ReviewRecord['kind']) => atHead.filter((r) => r.kind === kind).at(-1);
  const agent = latest('agent');
  const human = latest('human');
  const checks: CheckResult[] = [
    check('agent-review', '独立审查 agent 通过（针对当前 commit）', [
      ...(!agent ? ['没有针对当前 commit 的 agent 审查'] : []),
      ...(agent && agent.verdict !== 'pass' ? ['agent 审查未通过'] : []),
      ...(agent && agent.coverage.length === 0 ? ['审查没有覆盖范围回执'] : []),
      ...(agent?.findings.filter((f) => f.severity === 'blocking').map((f) => `阻塞问题：${f.anchor ? `[${f.anchor}] ` : ''}${f.text}`) ?? []),
      ...(agent?.findings.filter((f) => f.severity === 'blocking' && !f.anchor).map((f) => `阻塞问题缺少锚点：${f.text}`) ?? []),
    ]),
    check('human-signoff', '开发者签字（针对当前 commit）', [
      ...(!human ? ['开发者尚未签字'] : []),
      ...(human && human.verdict !== 'pass' ? ['开发者签字为不通过'] : []),
    ]),
  ];
  return evaluation('G6B', checks, { kind: 'commit', value: headSha }, now);
}

/** 双子门禁：两道门都通过，且绑定同一个 commit */
export function evaluateTwin(a: GateEvaluation, b: GateEvaluation, headSha: string, now: string): GateEvaluation {
  return evaluation(
    'G6',
    [
      check('6A', '验证门通过', a.status === 'passed' ? [] : ['验证门未通过']),
      check('6B', '审查门通过', b.status === 'passed' ? [] : ['审查门未通过']),
      check('same-commit', '两道门绑定同一个 commit，且就是当前 HEAD', [
        ...(a.boundTo.value !== b.boundTo.value ? ['两道门绑定的 commit 不一致'] : []),
        ...(a.boundTo.value !== headSha ? ['验证门绑定的不是当前 HEAD'] : []),
      ]),
    ],
    { kind: 'commit', value: headSha },
    now,
  );
}
