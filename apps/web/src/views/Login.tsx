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
      <p className="muted">登录后可查看当前角色需要处理的事项。</p>
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
      <p className="muted small">请填写管理员发给你的用户名和登录令牌。没有令牌或忘记了，请联系管理员。</p>
    </form>
  );
}
