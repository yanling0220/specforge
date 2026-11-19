import { useCallback, useEffect, useState } from 'react';
import type { ReviewFinding } from '@specforge/shared';
import { ApiError, type ReviewDiffFile, type ReviewFile, type ReviewRecordView, type ReviewSnapshot } from '../api.ts';
import { formatTime, href, STAGE_LABEL } from '../model.ts';
import { numberedPatch, readReviewFile, readReviewSnapshot, reviewReadError, watchReviewRead } from '../review-read.ts';
import { ChangeTabs } from './ChangeTabs.tsx';
import { StatusIcon } from './common.tsx';

const CHECK_INTERVAL = 15_000;
const REPORT_LABEL = { agent: 'Agent 审查', human: '开发者签字' } as const;
const DISPOSITION = { current: '当前记录', superseded: '已被同类后续记录替代', historical: '历史提交' } as const;
const AREA_STATUS = { unavailable: '读取失败', too_large: '超出读取限制', timeout: '读取超时', not_available: '不适用' } as const;
const FILE_STATUS = { A: '新增', M: '修改', D: '删除', T: '类型变化' } as const;
const FILE_KIND = { file: '', symlink: '符号链接', submodule: '子模块', type_change: '类型变化', unavailable: '不可显示' } as const;
const EVIDENCE_SCOPE = { target: '目标验证', baseline: '基线验证', target_and_baseline: '目标及基线验证', task: '任务 TDD' } as const;
const FINDING_KIND = { missing: '缺失', regression: '回归', unplanned: '计划外改动' } as const;
type FindingFilter = 'all' | ReviewFinding['severity'];

function reviewErrorText(error: Error) {
  if (error instanceof ApiError) {
    if (error.status === 413) return AREA_STATUS.too_large;
    if (error.code === 'review_timeout') return AREA_STATUS.timeout;
  }
  return error.message;
}

type SnapshotRead = { version: number; attempt: number; data?: ReviewSnapshot; error?: Error };

export function ReviewView({ id, version }: { id: string; version: number }) {
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<SnapshotRead>();
  const [notice, setNotice] = useState<string>();
  const settled = read?.version === version && read.attempt === attempt;
  const refresh = () => setAttempt((value) => value + 1);

  useEffect(() => watchReviewRead((signal) => readReviewSnapshot(id, signal),
    (result) => setRead({ version, attempt, ...result })), [id, version, attempt]);

  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), CHECK_INTERVAL);
    return () => clearTimeout(timer);
  }, [version, attempt, settled]);

  const invalidate = useCallback((reason: 'stale' | 'snapshot') => {
    setRead(undefined);
    setNotice(reason === 'stale' ? '审查快照已变化，正在重新读取。' : '正在重新核对审查快照。');
    setAttempt((value) => value + 1);
  }, []);

  return (
    <div className="review">
      <div className="crumbs"><a href={href({ page: 'board' })}>看板</a> / <code>{id}</code></div>
      <ChangeTabs id={id} tab="review" />
      <div className="review-toolbar">
        <h1>代码审查</h1>
        <button type="button" onClick={() => {
          setNotice(undefined);
          refresh();
        }} disabled={!settled}>刷新审查</button>
      </div>
      {!settled && <p role="status" className="muted">
        {read?.data ? <>正在检查更新。下方为上次读取的快照 <code>{read.data.snapshotVersion.slice(0, 12)}</code>。</>
          : notice ?? '正在读取审查快照…'}
      </p>}
      {settled && read.error && <p role="alert" className="error">审查快照无法加载：{reviewErrorText(read.error)}</p>}
      {read?.data && (
        <div inert={!settled} aria-busy={!settled}>
          <ReviewContent key={read.data.snapshotVersion} snapshot={read.data} onInvalid={invalidate} />
        </div>
      )}
    </div>
  );
}

function ReviewContent({ snapshot, onInvalid }: {
  snapshot: ReviewSnapshot;
  onInvalid: (reason: 'stale' | 'snapshot') => void;
}) {
  const { changeId: id, latestReports, reviewGate, reports } = snapshot;
  const [findingFilter, setFindingFilter] = useState<FindingFilter>('all');
  const bySequence = new Map(reports.map((report) => [report.seq, report]));
  const history = reports.filter((report) => report.disposition !== 'current').reverse();

  function showReport(seq: number) {
    setFindingFilter('all');
    const report = document.getElementById('review-report-' + seq);
    report?.focus({ preventScroll: true });
    report?.scrollIntoView({ block: 'start' });
  }

  return (
    <>
      <section className="panel">
        <h2>提交范围 <small className="muted">{STAGE_LABEL[snapshot.stage]}</small></h2>
        {snapshot.available ? (
          <>
            <dl className="review-range">
              <dt>基线</dt><dd><code>{snapshot.baseSha}</code></dd>
              <dt>目标 HEAD</dt><dd><code>{snapshot.targetSha}</code></dd>
            </dl>
            <p className="muted">仅比较这两个提交的文件树，范围可能包含其他变更。暂存、未提交和未跟踪的内容均不参与。</p>
            {snapshot.diff.status === 'complete' && !snapshot.diff.baseIsAncestor &&
              <p className="banner warn">基线不在目标提交的历史中。下方为两个提交树的比较。</p>}
          </>
        ) : <p className="muted">进入实现阶段后可查看提交范围、文件差异与 AC 追溯。</p>}
      </section>

      {snapshot.available && (
        <section className="panel">
          <div className="review-toolbar">
            <h2>当前审查</h2>
            <a href={href({ page: 'change', id, tab: 'gates' })}>查看门禁 / 签字</a>
          </div>
          {reviewGate && (
            <div className="review-gate">
              <strong><StatusIcon status={reviewGate.status} /> G6B · {
                reviewGate.status === 'passed' ? '通过' : reviewGate.status === 'failed' ? '未通过' : '未验证'
              }</strong>
              <ul className="checks">
                {reviewGate.checks.map((check) => (
                  <li key={check.id} className={check.passed ? 'pass' : 'fail'}>
                    <StatusIcon status={check.passed ? 'passed' : 'failed'} /> {check.label}
                    {check.detail && <div className="detail">{check.detail}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="review-filter">发现项
            <select value={findingFilter} onChange={(event) => setFindingFilter(event.target.value as FindingFilter)}>
              <option value="all">全部</option>
              <option value="blocking">阻塞</option>
              <option value="non-blocking">非阻塞</option>
            </select>
          </label>
          <div className="review-current">
            {(['agent', 'human'] as const).map((kind) => {
              const report = bySequence.get(latestReports[kind] ?? -1);
              return report ? <Report key={kind} id={id} report={report} filter={findingFilter} />
                : <p className="muted" key={kind}>当前提交尚无{REPORT_LABEL[kind]}。</p>;
            })}
          </div>
        </section>
      )}

      {snapshot.available && (
        <>
          <DiffPanel snapshot={snapshot} onInvalid={onInvalid} />
          <TracePanel snapshot={snapshot} showReport={showReport} />
          <EvidencePanel id={id} entries={snapshot.evidence} />
        </>
      )}

      <section className="panel">
        <h2>历史报告</h2>
        {history.length === 0 ? <p className="muted">暂无历史报告。</p> : history.map((report) => (
          <details className="review-history" key={report.seq}>
            <summary>{REPORT_LABEL[report.record.kind]} #{report.seq} · {DISPOSITION[report.disposition]} · {
              report.record.verdict === 'pass' ? '报告通过' : '报告未通过'
            } · <code>{report.record.sha.slice(0, 12)}</code></summary>
            <Report id={id} report={report} filter={findingFilter} />
          </details>
        ))}
      </section>
    </>
  );
}

function Report({ id, report, filter }: { id: string; report: ReviewRecordView; filter: FindingFilter }) {
  const { record, seq, disposition } = report;
  const findings = report.findings.filter(({ finding }) => filter === 'all' || finding.severity === filter);
  return (
    <article className="review-report" id={'review-report-' + seq} tabIndex={-1}>
      <h3>{REPORT_LABEL[record.kind]} #{seq} · {record.verdict === 'pass' ? '报告通过' : '报告未通过'}</h3>
      <p className="muted">{record.reviewer.name}（{record.reviewer.role}） · {formatTime(record.at)} · <code>{record.sha}</code></p>
      <p className="muted">{disposition === 'current' ? '用于当前 G6B 评估' : '未用于当前 G6B 评估'}</p>
      {record.note && <p className="review-literal">{record.note}</p>}
      <div>审查声明{record.coverage.length === 0 ? '：未填写' : (
        <ul>{record.coverage.map((item, index) => <li className="review-literal" key={index}>{item}</li>)}</ul>
      )}</div>
      {findings.length === 0 ? <p className="muted">{report.findings.length ? '没有符合筛选条件的发现项。' : '没有记录发现项。'}</p>
        : <ol className="review-findings">{findings.map(({ finding, index, acLink, questionId, questionLink }) => (
          <li key={index} value={index}>
            <strong className={finding.severity === 'blocking' ? 'fail' : ''}>{finding.severity === 'blocking' ? '阻塞' : '非阻塞'}</strong>
            {' · '}{finding.kind ? FINDING_KIND[finding.kind] : '未标注类别'}{' · '}
            {finding.anchor ? <code className="review-literal">{finding.anchor}</code> : '未标注定位'}
            {acLink === 'ambiguous' && '（规格编号重复）'}
            {questionLink === 'current-question' && questionId && <> · <a href={href({ page: 'change', id, tab: 'analysis', qid: questionId })}>查看当前问题</a></>}
            <div className="review-literal">{finding.text}</div>
          </li>
        ))}</ol>}
    </article>
  );
}

function DiffPanel({ snapshot, onInvalid }: {
  snapshot: ReviewSnapshot;
  onInvalid: (reason: 'stale' | 'snapshot') => void;
}) {
  const { changeId, snapshotVersion, diff } = snapshot;
  const [selected, setSelected] = useState<string>();
  const file = diff.status === 'complete' ? diff.files.find((entry) => entry.id === selected) : undefined;

  return (
    <section className="panel">
      <h2>提交差异</h2>
      {diff.status !== 'complete' ? <p className="banner warn">文件清单：{AREA_STATUS[diff.status]}。</p> : (
        <>
          {diff.excludedFiles > 0 && <p className="muted">已排除 {diff.excludedFiles} 个平台内部路径。</p>}
          {diff.files.length === 0 ? <p className="muted">{
            diff.excludedFiles ? '没有可展示的差异。'
              : diff.baseSha === diff.targetSha ? '两个提交相同，无差异。' : '两个提交的文件树没有差异。'
          }</p> : (
            <div className="review-diff">
              <div className="file-list review-files" aria-label="变更文件">
                {diff.files.map((entry) => (
                  <button type="button" key={entry.id} className={selected === entry.id ? 'active' : ''}
                    aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>
                    <b>{FILE_STATUS[entry.status]}</b>{' '}
                    <span className="review-literal">{entry.path ?? '路径无法解码'}</span>
                    {FILE_KIND[entry.kind] && <small className="muted"> · {FILE_KIND[entry.kind]}</small>}
                  </button>
                ))}
              </div>
              <div>
                {file ? <FilePanel key={file.id} id={changeId} version={snapshotVersion} file={file} onInvalid={onInvalid} />
                  : <p className="muted">选择文件查看差异。</p>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FilePanel({ id, version, file, onInvalid }: {
  id: string; version: string; file: ReviewDiffFile;
  onInvalid: (reason: 'stale' | 'snapshot') => void;
}) {
  const [result, setResult] = useState<{ data: ReviewFile } | { error: Error }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => watchReviewRead((signal) => readReviewFile(id, version, file.id, signal), (next) => {
    if ('error' in next) {
      const failure = reviewReadError(next.error);
      if (failure !== 'file') {
        onInvalid(failure);
        return;
      }
    }
    setResult(next);
  }), [id, version, file.id, attempt, onInvalid]);

  return (
    <section className="review-file-detail" aria-label="文件差异">
      <h3><code className="review-literal">{file.path ?? '路径无法解码'}</code></h3>
      <p className="muted">对象模式 <code>{file.oldMode}</code> → <code>{file.newMode}</code></p>
      {!result ? <p role="status" className="muted">正在读取文件…</p> : 'data' in result ? <FileResult result={result.data} />
        : <p role="alert" className="error">文件无法加载：{reviewErrorText(result.error)}{' '}
          <button type="button" onClick={() => {
            setResult(undefined);
            setAttempt((value) => value + 1);
          }}>重试文件</button></p>}
    </section>
  );
}

function FileResult({ result }: { result: ReviewFile }) {
  switch (result.kind) {
    case 'text':
    case 'symlink':
      return (
        <>
          {result.kind === 'symlink' && <p className="muted">符号链接 · 以下是链接目标文本的差异。</p>}
          {result.patch ? <>
            <p className="muted small">左列为旧行号，右列为新行号。− 删除，+ 新增。</p>
            <pre className="review-patch" tabIndex={0} aria-label="统一差异">{numberedPatch(result.patch)}</pre>
          </> : <p className="muted">没有文本行变动。文件模式见上方。</p>}
        </>
      );
    case 'binary':
      return <p>二进制文件 · 大小 {result.oldBytes ?? '—'} → {result.newBytes ?? '—'} 字节</p>;
    case 'submodule':
    case 'type_change':
      return <p>{FILE_KIND[result.kind]} · 对象 <code>{result.file.oldOid}</code> → <code>{result.file.newOid}</code></p>;
    case 'unavailable':
      return <p className="banner warn">{result.reason === 'encoding' ? '文件路径或差异文本无法解码。' : '此 Git 对象类型无法显示。'}</p>;
  }
}

type TraceArea = ReviewSnapshot['trace']['specs'];

function TracePanel({ snapshot, showReport }: { snapshot: ReviewSnapshot; showReport: (seq: number) => void }) {
  const [query, setQuery] = useState('');
  const { trace, acTrace } = snapshot;
  const filter = query.trim().toUpperCase();
  const rows = acTrace.filter((row) => row.acId.includes(filter));
  return (
    <section className="panel">
      <div className="review-toolbar">
        <h2>AC 追溯</h2>
        <label className="review-filter">按 AC 编号查找
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="AC-1" />
        </label>
      </div>
      <p className="muted">测试文件中的编号引用和报告中的声明供核对。验证结果见{' '}
        <button type="button" className="link" onClick={() => {
          const section = document.getElementById('review-evidence');
          section?.focus({ preventScroll: true });
          section?.scrollIntoView({ block: 'start' });
        }}>引擎证据</button>。</p>
      <ul className="review-areas">
        <li>规格：{areaText(trace.specs, '没有规格文件')}</li>
        <li>任务：{areaText(trace.tasks, '没有任务清单')}</li>
        <li>测试引用：{trace.tests.status === 'not_available' && trace.specs.status !== 'complete'
          ? '规格未成功读取，未扫描' : areaText(trace.tests, '无匹配的测试文件')}</li>
      </ul>
      {rows.length ? (
        <div className="review-table-area" tabIndex={0} role="region" aria-label="AC 追溯表">
          <table className="review-table">
            <thead><tr><th>AC</th><th>规格位置</th><th>任务</th><th>字面测试引用</th><th>当前报告引用</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.spec.file + ':' + row.spec.scenarioLine + ':' + row.acId}>
                <th scope="row"><code>{row.acId}</code>{row.ambiguous && <div className="warn-text">编号重复（{row.occurrenceCount} 处）</div>}</th>
                <td>{row.spec.requirementTitle}<br />{row.spec.scenarioTitle}<br />
                  <code className="review-literal">{row.spec.file}:{row.spec.scenarioLine}</code></td>
                <td>{row.tasks.length ? (
                  <ul>{row.tasks.map((task) => <li key={task.line}><code>{task.id}</code> {task.title}（{task.done ? '已勾选' : '未勾选'}）</li>)}</ul>
                ) : areaEmpty(trace.tasks, '无关联任务')}</td>
                <td>{row.testFiles.length ? (
                  <ul>{row.testFiles.map((path) => <li key={path}><code className="review-literal">{path}</code></li>)}</ul>
                ) : areaEmpty(trace.tests, '无编号引用')}</td>
                <td>{row.reviewSeqs.length || row.findingRefs.length ? <ul>
                  {row.reviewSeqs.map((seq) => <li key={seq}><button className="link" type="button" onClick={() => showReport(seq)}>报告 #{seq} 的声明</button></li>)}
                  {row.findingRefs.map(({ reviewSeq, findingIndex }) => <li key={reviewSeq + ':' + findingIndex}>
                    <button className="link" type="button" onClick={() => showReport(reviewSeq)}>报告 #{reviewSeq} 的发现项 {findingIndex}</button>
                  </li>)}
                </ul> : '无精确引用'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted">{
        acTrace.length ? '没有匹配的 AC。' : trace.specs.status === 'complete' ? '规格中没有 AC。' : 'AC 追溯不可用。'
      }</p>}
    </section>
  );
}

function areaText(area: TraceArea, empty: string) {
  return area.status === 'complete' ? area.fileCount ? '已读取 ' + area.fileCount + ' 个文件' : empty : AREA_STATUS[area.status];
}

function areaEmpty(area: TraceArea, empty: string) {
  return area.status === 'complete' ? empty : AREA_STATUS[area.status];
}

function EvidencePanel({ id, entries }: { id: string; entries: ReviewSnapshot['evidence'] }) {
  return (
    <section className="panel" id="review-evidence" tabIndex={-1}>
      <h2>引擎证据</h2>
      {entries.length === 0 ? <p className="muted">这个提交范围暂无验证或任务 TDD 证据。</p> : (
        <ul className="review-evidence">
          {entries.map((entry) => (
            <li key={entry.seq}>
              {EVIDENCE_SCOPE[entry.scope]}{entry.taskId && ' · ' + entry.taskId} · <code>{entry.sha}</code> · 事件 #{entry.seq}{' · '}
              {entry.hashOk ? (
                <><span className={entry.passed ? 'pass' : 'fail'}>{entry.passed ? '通过' : '未通过'}</span>{' · 哈希一致 · '}</>
              ) : <strong className="fail">证据缺失或哈希不符 · </strong>}
              <a href={href({ page: 'evidence', id, eid: entry.id })}>查看证据</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
