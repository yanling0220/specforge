import type { StepEvidence, TddEvidence, TddRun, VerificationEvidence } from '@specforge/shared';
import { api } from '../api.ts';
import { useData } from '../live.ts';
import { formatTime, href } from '../model.ts';
import { Loading, Raw } from './common.tsx';

export function EvidenceView({ id, eid }: { id: string; eid: string }) {
  const { data, error } = useData(() => api.evidenceDetail(id, eid), [id, eid]);
  if (!data) return <Loading error={error} />;
  const { entry, content } = data;

  return (
    <>
      <div className="crumbs">
        <a href={href({ page: 'board' })}>看板</a> / <a href={href({ page: 'change', id, tab: 'gates' })}>{id}</a> / 证据
      </div>
      <h1>
        {entry.kind === 'tdd' ? `G5 TDD 证据 · ${entry.taskId}` : '验证证据（G6A）'} <small className="muted">{entry.id}</small>
      </h1>
      {!entry.hashOk && <div className="banner bad">⚠️ 证据文件与事件日志中记录的哈希不一致（被修改或缺失），引擎不会采信这份证据</div>}
      <p>
        结论：<b className={entry.passed ? 'pass' : 'fail'}>{entry.passed ? '通过' : '未通过'}</b> · commit <code>{entry.sha.slice(0, 12)}</code> · 记录者{' '}
        {entry.actor.name} · {formatTime(entry.at)}（事件 #{entry.seq}）
      </p>
      {entry.kind === 'tdd' ? <Tdd ev={content as TddEvidence} /> : <Verify ev={content as VerificationEvidence} />}
      <Raw value={content} label="证据原文" />
    </>
  );
}

function Verify({ ev }: { ev: VerificationEvidence }) {
  return (
    <>
      <p className="muted">
        在从 <code>{ev.sha.slice(0, 7)}</code> 检出的干净 worktree 中执行 · {formatTime(ev.startedAt)} → {formatTime(ev.finishedAt)} · Node {ev.host.node} / {ev.host.platform}
        {ev.mainTreeDirty && ' · 当时主工作区有未提交改动（不在验证范围内）'}
      </p>
      {ev.steps.map((s) => (
        <Step key={s.name} step={s} />
      ))}
    </>
  );
}

function Tdd({ ev }: { ev: TddEvidence }) {
  return (
    <>
      <p className="muted">
        测试文件：{ev.testFiles.length ? ev.testFiles.map((f) => <code key={f}>{f} </code>) : '（没有新增或修改测试文件）'}
      </p>
      <h2>RED：在实现前（{ev.base.slice(0, 7)}）运行新测试，应当失败</h2>
      <Run run={ev.red} expectFail />
      <h2>GREEN：在任务 commit（{ev.sha.slice(0, 7)}）上运行，应当通过</h2>
      <Run run={ev.green} />
    </>
  );
}

function Run({ run, expectFail }: { run: TddRun; expectFail?: boolean }) {
  if (!run.setup && !run.test) return <p className="muted">未执行</p>;
  return (
    <>
      {run.setup && <Step step={run.setup} />}
      {run.test && <Step step={run.test} expectFail={expectFail} />}
    </>
  );
}

function Step({ step, expectFail }: { step: StepEvidence; expectFail?: boolean }) {
  const ok = step.exitCode === 0 && !step.timedOut;
  const good = expectFail ? !ok && !step.timedOut : ok;
  return (
    <section className={`step-card ${good ? 'ok' : 'bad'}`}>
      <h3>
        <span className={good ? 'pass' : 'fail'}>{good ? '✓' : '✗'}</span> {step.name} <code>{step.command}</code>
        <span className="muted">
          {' '}
          · 退出码 {step.timedOut ? '超时' : step.exitCode} · {step.durationMs}ms
        </span>
      </h3>
      <pre className="output">{step.outputTail || '（无输出）'}</pre>
      <div className="muted small">输出只保留末尾 8KB；完整输出哈希 {step.outputHash.slice(0, 16)}…</div>
    </section>
  );
}
