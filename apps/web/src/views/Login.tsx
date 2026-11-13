import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

/** 用 sf user add / sf user token 生成的令牌登录 */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(name.trim(), token.trim());
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login panel" onSubmit={submit}>
      <h1>登录 SpecForge</h1>
      <label>
        用户名
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label>
        登录令牌
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
      <p className="muted small">令牌由管理员用 sf user add 或 sf user token 生成，只显示一次。忘记了请让管理员重置。</p>
    </form>
  );
}
