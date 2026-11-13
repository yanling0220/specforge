import { useState, type FormEvent } from 'react';

// 写操作按钮：点开后填写表单 → 调用接口 → 成功后收起并通知刷新。
// 校验以服务端为准，这里只做必填提示；服务端的拒绝原因原样展示。

export interface Field {
  key: string;
  label: string;
  kind?: 'text' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
}

export function Action({
  label,
  fields = [],
  confirm,
  danger,
  disabled,
  title,
  run,
  onDone,
}: {
  label: string;
  fields?: Field[];
  /** 没有字段时，点击前的确认提示 */
  confirm?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  run: (values: Record<string, string>) => Promise<unknown>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.options?.[0]?.value ?? ''])));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await run(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      setOpen(false);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!fields.length && !open) {
    return (
      <span className="action">
        <button
          className={`btn ${danger ? 'danger' : ''}`}
          disabled={disabled || busy}
          title={title}
          onClick={() => {
            if (!confirm || window.confirm(confirm)) void submit();
          }}
        >
          {busy ? '提交中…' : label}
        </button>
        {error && <span className="error inline">{error}</span>}
      </span>
    );
  }

  if (!open) {
    return (
      <span className="action">
        <button className={`btn ${danger ? 'danger' : ''}`} disabled={disabled} title={title} onClick={() => setOpen(true)}>
          {label}
        </button>
      </span>
    );
  }

  return (
    <form className="action-form" onSubmit={submit}>
      <b>{label}</b>
      {fields.map((f) => (
        <label key={f.key}>
          {f.label}
          {f.required && <span className="fail"> *</span>}
          {f.kind === 'select' ? (
            <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              {f.options!.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.kind === 'textarea' ? (
            <textarea value={values[f.key]} placeholder={f.placeholder} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} rows={3} />
          ) : (
            <input value={values[f.key]} placeholder={f.placeholder} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="action-buttons">
        <button type="submit" className={`btn primary ${danger ? 'danger' : ''}`} disabled={busy}>
          {busy ? '提交中…' : '提交'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}
