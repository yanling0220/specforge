import type { GateEvaluation } from '@specforge/shared';
import { api, type EvidenceEntry } from '../api.ts';
import { useData } from '../live.ts';
import { evidenceForGate, formatTime, GATE_LABEL, href, orderedGates, pipelineSteps, STAGE_LABEL } from '../model.ts';
import { Loading, StatusIcon } from './common.tsx';
import { Timeline } from './Timeline.tsx';

export function ChangeView({ id, tab, version }: { id: string; tab: 'gates' | 'timeline'; version: number }) {
  const detail = useData(() => api.change(id), [id, version]);
  const gates = useData(() => api.gates(id), [id, version]);
  const evidence = useData(() => api.evidence(id), [id, version]);

  if (!detail.data || !gates.data) return <Loading error={detail.error ?? gates.error} />;
  const { change, questions } = detail.data;
  const steps = pipelineSteps(gates.data);
  const openBlocking = questions.filter((q) => q.severity === 'blocking' && !['confirmed', 'deferred', 'invalidated'].includes(q.status));
  const fix = change.fixRounds?.at(-1);

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
      {openBlocking.length > 0 && (
        <div className="banner warn">
          ⏸ {openBlocking.length} 个阻塞问题待处理：
          {openBlocking.map((q) => (
            <span key={q.id} className="q">
              <b>{q.id}</b> {q.question}
            </span>
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

      <div className="tabs">
        <a className={tab === 'gates' ? 'active' : ''} href={href({ page: 'change', id, tab: 'gates' })}>
          门禁
        </a>
        <a className={tab === 'timeline' ? 'active' : ''} href={href({ page: 'change', id, tab: 'timeline' })}>
          事件时间线
        </a>
      </div>

      {tab === 'gates' ? (
        <>
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
