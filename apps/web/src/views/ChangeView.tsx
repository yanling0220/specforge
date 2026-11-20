import { useState } from 'react';
import type { GateEvaluation, GateId } from '@specforge/shared';
import { api, type ChangeDetail, type EvidenceEntry, type GatesResponse } from '../api.ts';
import { useMe } from '../me.tsx';
import { Action } from './Action.tsx';
import { useData } from '../live.ts';
import { evidenceForGate, formatTime, GATE_LABEL, href, orderedGates, pipelineSteps, STAGE_LABEL } from '../model.ts';
import { Loading, StatusIcon } from './common.tsx';
import { AnalysisView } from './AnalysisView.tsx';
import { ArtifactsView } from './ArtifactsView.tsx';
import { Timeline } from './Timeline.tsx';
import { ReviewView } from './ReviewView.tsx';
import { ChangeTabs, type ChangeTab } from './ChangeTabs.tsx';
import { QuestionWorkDetailView } from './QuestionWorkDetail.tsx';
import { roleLabel } from '../question-work.ts';

export function ChangeView({ id, tab, qid, version }: { id: string; tab: ChangeTab; qid?: string; version: number }) {
  const { user, role } = useMe();
  if (tab === 'review') return <ReviewView key={id} id={id} version={version} />;
  if (tab === 'analysis' && qid && user && (role === 'dev' || role === 'product')) {
    return <QuestionWorkDetailView key={JSON.stringify([id, qid, user.name, role])} changeId={id} questionId={qid} version={version} name={user.name} role={role} />;
  }
  return <ChangeDetails key={id} id={id} tab={tab} qid={qid} version={version} />;
}

function ChangeDetails({ id, tab, qid, version }: { id: string; tab: Exclude<ChangeTab, 'review'>; qid?: string; version: number }) {
  // 写操作成功后立即刷新（WebSocket 推送也会触发刷新）
  const [local, setLocal] = useState(0);
  const refresh = () => setLocal((v) => v + 1);
  const detail = useData(() => api.change(id), [id, version, local]);
  const gates = useData(() => api.gates(id), [id, version, local]);
  const evidence = useData(() => api.evidence(id), [id, version, local]);

  if (!detail.data || !gates.data) return <Loading error={detail.error ?? gates.error} />;
  const { change, questions } = detail.data;
  const steps = pipelineSteps(gates.data);
  const openBlocking = questions.filter((q) => q.severity === 'blocking' && !['confirmed', 'deferred', 'invalidated'].includes(q.status));
  const fix = change.fixRounds?.at(-1);
  const openComments = (detail.data.comments ?? []).filter((c) => c.status !== 'resolved').length;

  return (
    <>
      <div className="crumbs">
        <a href={href({ page: 'board' })}>看板</a> / <code>{change.id}</code>
      </div>
      <h1>
        {change.title} <small className="muted">{change.tier} 档 · 当前阶段：{STAGE_LABEL[change.stage]}</small>
      </h1>

      <ol className="pipeline">
        {steps.map((s) => (
          <li key={s.stage} className={`${s.state} ${s.invalidated ? 'invalidated' : ''}`} title={s.gate ? `${GATE_LABEL[s.gate]}：${s.gateStatus ?? '未评估'}` : ''}>
            <span className="step">{s.label}</span>
            {s.gate && (
              <span className="gate">
                <StatusIcon status={s.gateStatus} /> {s.gate}
              </span>
            )}
          </li>
        ))}
      </ol>

      {detail.data.outOfBand && <div className="banner bad">⚠️ 状态文件被绕过引擎修改（{detail.data.outOfBand}），需要 sf log ack 确认</div>}
      {change.escalation && (
        <div className="banner bad">
          ⚠️ 已升级给人处理：{change.escalation.reason}（{formatTime(change.escalation.at)}）
        </div>
      )}
      {gates.data.upstreamInvalid.length > 0 && <div className="banner warn">⚠️ 上游门禁已失效：{gates.data.upstreamInvalid.join(', ')}，需要重新满足后才能继续推进</div>}
      {tab !== 'gates' && openBlocking.length > 0 && (
        <div className="banner warn">
          ⏸ {openBlocking.length} 个阻塞问题待处理：
          {openBlocking.map((q) => (
            <a key={q.id} className="q" href={href({ page: 'change', id, tab: 'analysis', qid: q.id })}>
              <b>{q.id}</b> {q.question}
            </a>
          ))}
        </div>
      )}
      {fix && !fix.resolvedSha && (
        <div className="banner warn">
          ↩️ 第 {fix.round} 轮修复进行中（{fix.source === 'agent' ? 'agent 审查' : '开发者'}打回 <code>{fix.sha.slice(0, 7)}</code>）
          <ul>
            {fix.findings.map((f, i) => (
              <li key={i}>
                {f.anchor && <b>[{f.anchor}] </b>}
                {f.kind && <i>({f.kind}) </i>}
                {f.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.data.uncommittedSpecChanges.length > 0 && (
        <div className="banner warn">OpenSpec 有未提交的改动，不参与门禁评估：{detail.data.uncommittedSpecChanges.join(', ')}</div>
      )}

      <ChangeTabs id={id} tab={tab} openBlocking={openBlocking.length} openComments={openComments} />

      {tab === 'artifacts' ? (
        <ArtifactsView id={id} version={version + local} onChanged={refresh} />
      ) : tab === 'analysis' ? (
        <AnalysisView detail={detail.data} qid={qid} onChanged={refresh} />
      ) : tab === 'gates' ? (
        <>
          <GateActions key={change.stage} id={id} detail={detail.data} gates={gates.data}
            checking={detail.loading || gates.loading || change.stage !== gates.data.stage} onDone={refresh} />
          {detail.data.tasks.length > 0 && <TasksPanel id={id} detail={detail.data} onDone={refresh} />}
          <p className="muted">
            门禁按{detail.data.factsSource.kind === 'commit' ? ` HEAD（${detail.data.factsSource.sha.slice(0, 7)}）` : '工作区'}中的 OpenSpec 文件实时评估
          </p>
          <div className="gates">
            {orderedGates(gates.data).map((g) => (
              <GateCard key={g.gate} gate={g} changeId={id} evidence={evidence.data ?? []} />
            ))}
          </div>
        </>
      ) : (
        <Timeline changeId={id} version={version} />
      )}
    </>
  );
}

function GateCard({ gate, changeId, evidence }: { gate: GateEvaluation; changeId: string; evidence: EvidenceEntry[] }) {
  const linked = evidenceForGate(gate, evidence);
  return (
    <section className={`gate-card ${gate.status}`}>
      <h3>
        <StatusIcon status={gate.status} /> {GATE_LABEL[gate.gate]}
        <span className="bound muted">
          绑定 {gate.boundTo.kind === 'commit' ? 'commit' : '内容'} <code>{gate.boundTo.value.slice(0, 12)}</code>
        </span>
      </h3>
      <ul className="checks">
        {gate.checks.map((c) => (
          <li key={c.id} className={c.passed ? 'pass' : 'fail'}>
            <StatusIcon status={c.passed ? 'passed' : 'failed'} /> {c.label}
            {c.detail && <div className="detail">{c.detail}</div>}
          </li>
        ))}
      </ul>
      {linked.length > 0 && (
        <div className="evidence-links">
          证据：
          {linked.map((e) => (
            <a key={e.id} href={href({ page: 'evidence', id: changeId, eid: e.id })} className={`ev ${e.passed ? 'pass' : 'fail'} ${e.hashOk ? '' : 'tampered'}`}>
              {e.taskId ? `${e.taskId} ` : ''}
              {e.passed ? '✓' : '✗'} {e.sha.slice(0, 7)} · {formatTime(e.at)}
              {!e.hashOk && ' · 哈希不一致'}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** 门禁相关的人工操作：审批与签字 / 打回需要 dev 角色；推进由门禁把关。服务端最终校验 */
function GateActions({ id, detail, gates, checking, onDone }: {
  id: string; detail: ChangeDetail; gates: GatesResponse; checking: boolean; onDone: () => void;
}) {
  const { canWrite, role } = useMe();
  if (!canWrite || !role) return null;
  const { stage } = detail.change;
  const needsApproval = (g?: GateEvaluation) => !!g?.checks.some((c) => c.id === 'approved' && !c.passed);
  const notDev = role !== 'dev';
  const devOnly = notDev ? '需要开发身份' : undefined;
  const current = gates.pipeline.findIndex((p) => p.stage === stage);
  const next = current < 0 ? undefined : gates.pipeline[current + 1];
  const exit = gates.pipeline[current]?.exitGate;
  const blocked = [...gates.upstreamInvalid, ...(exit && gates.gates[exit]?.status !== 'passed' ? [exit] : [])];
  const specApproval = blocked.includes('G2') && needsApproval(gates.gates.G2);
  const designApproval = blocked.includes('G3') && needsApproval(gates.gates.G3);

  if (!next) return <p className="muted">{stage === 'delivered' ? '此变更已交付。' : '暂时无法识别当前阶段。'}</p>;
  return <>
    {checking && <p role="status">正在核对能否进入下一阶段…</p>}
    <section className="panel stage-next" hidden={checking}>
    <h2>{blocked.length ? `进入「${STAGE_LABEL[next.stage]}」前还需完成` : `可以进入「${STAGE_LABEL[next.stage]}」`}</h2>
    {blocked.length > 0 && <ul className="stage-blockers">
      {blocked.flatMap((id) => {
        const checks = gates.gates[id]?.checks.filter((check) => !check.passed);
        return checks?.length ? checks.map((check) => <li key={`${id}:${check.id}`}>
          {check.label}{blockerLink(detail.change.id, id, check.id)}
        </li>) : [<li key={id}>{GATE_LABEL[id]}还未验证</li>];
      })}
    </ul>}
    {notDev && (specApproval || designApproval || stage === 'closing') && <p>审批和签字由开发角色处理。</p>}
    <div className="action-bar">
      {specApproval && (
        <Action label="审批当前规格" disabled={checking || notDev} title={devOnly} confirm="确认通过当前版本的规格？规格修改后需要重新审批。" run={() => api.approve(id, { role, target: 'spec' })} onDone={onDone} />
      )}
      {designApproval && (
        <Action label="审批当前方案" disabled={checking || notDev} title={devOnly} confirm="确认通过当前版本的方案？方案修改后需要重新审批。" run={() => api.approve(id, { role, target: 'design' })} onDone={onDone} />
      )}
      {stage === 'closing' && (
        <>
          <Action
            label="签字通过"
            disabled={checking || notDev}
            title={devOnly}
            confirm={`以${roleLabel(role)}身份对当前提交签字通过？`}
            run={() => api.signoff(id, { role, verdict: 'pass' })}
            onDone={onDone}
          />
          <Action
            label="打回"
            danger
            disabled={checking || notDev}
            title={devOnly}
            fields={[
              { key: 'note', label: '打回原因', kind: 'textarea', required: true },
              { key: 'anchor', label: '锚点（AC 编号或问题编号，可选）', placeholder: 'AC-2' },
              {
                key: 'kind',
                label: '类型',
                kind: 'select',
                options: [
                  { value: 'missing', label: '漏做' },
                  { value: 'regression', label: '破坏已有' },
                  { value: 'unplanned', label: '计划外新增' },
                ],
              },
            ]}
            run={(v) =>
              api.signoff(id, {
                role,
                verdict: 'fail',
                note: v.note,
                findings: [{ severity: 'blocking', kind: v.kind as 'missing', text: v.note!, ...(v.anchor ? { anchor: v.anchor } : {}) }],
              })
            }
            onDone={onDone}
          />
        </>
      )}
      {!blocked.length && (
        <Action
          label={`推进到「${STAGE_LABEL[next.stage]}」`}
          disabled={checking}
          confirm={`确认进入「${STAGE_LABEL[next.stage]}」？`}
          run={() => api.advance(id, { role })}
          onDone={onDone}
        />
      )}
    </div>
    </section>
  </>;
}

function blockerLink(changeId: string, gate: GateId, check: string) {
  if (gate === 'G1') return <a href={href({ page: 'change', id: changeId, tab: 'analysis' })}>查看需求分析</a>;
  if (gate === 'G2' || gate === 'G3' || gate === 'G4') {
    const label = check === 'comments' ? '查看产物评论' : gate === 'G2' ? '查看规格' : gate === 'G3' ? '查看方案' : '查看任务清单';
    return <a href={href({ page: 'change', id: changeId, tab: 'artifacts' })}>{label}</a>;
  }
  return null;
}

/** 任务列表：完成 / 人接手 / 暂停 / 交给 agent；dev 可以接管或交还 */
function TasksPanel({ id, detail, onDone }: { id: string; detail: ChangeDetail; onDone: () => void }) {
  const { canWrite, role, user } = useMe();
  const { stage } = detail.change;
  const editable = canWrite && role === 'dev' && (stage === 'tasks' || stage === 'implement');
  return (
    <section className="panel tasks-panel">
      <h2>
        任务 <small className="muted">接管的任务由人实现，实现 agent 不处理；完成后提交并用 sf tdd 补 G5 证据</small>
      </h2>
      <table className="dims">
        <tbody>
          {detail.tasks.map((t) => {
            const claim = detail.claims[t.id];
            const paused = detail.pausedTasks[t.id];
            return (
              <tr key={t.id}>
                <td>
                  <b>{t.id}</b>
                </td>
                <td>
                  {t.title}
                  {t.dependsOn.length > 0 && <span className="muted">（依赖 {t.dependsOn.join(', ')}）</span>}
                </td>
                <td className="task-state">
                  {t.done ? (
                    <span className="pass">✓ 完成</span>
                  ) : claim ? (
                    <span className="warn-text" title={claim.note}>
                      👤 {claim.by.name} 接手 · {formatTime(claim.at)}
                    </span>
                  ) : paused ? (
                    <span className="fail">⏸ 等待 {paused.join(', ')}</span>
                  ) : (
                    <span className="muted">交给 agent</span>
                  )}
                </td>
                <td>
                  {editable && !t.done && !claim && (
                    <Action label="接管" fields={[{ key: 'note', label: '说明（可选）' }]} run={(v) => api.claimTask(id, t.id, { role: 'dev', note: v.note || undefined })} onDone={onDone} />
                  )}
                  {editable && claim && !t.done && (
                    <Action
                      label="交还给 agent"
                      fields={claim.by.name === user?.name ? [] : [{ key: 'reason', label: `由 ${claim.by.name} 接手，交还原因`, required: true }]}
                      confirm={claim.by.name === user?.name ? `把 ${t.id} 交还给实现 agent？` : undefined}
                      run={(v) => api.releaseTask(id, t.id, { role: 'dev', reason: v.reason || undefined })}
                      onDone={onDone}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
