import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const { login, isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const from = location.state?.from?.pathname || '/dashboard';

  if (!loading && isAuthenticated) return <Navigate to={from} replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const result = await login(email.trim(), password);
    setSubmitting(false);
    if (result.ok) navigate(from, { replace: true });
    else setError(result.error);
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
        <h1 className="mb-1 text-xl font-semibold text-slate-800">Compliance Portal</h1>
        <p className="mb-6 text-sm text-slate-500">Sign in to continue</p>

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
        </label>

        <label className="mb-6 block">
          <span className="mb-1 block text-sm font-medium text-slate-600">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-brand-600 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
