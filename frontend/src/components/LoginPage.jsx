import { useState } from 'react';
import { signInWithEmail, resetPassword } from '../lib/supabaseClient';

const MapIcon = () => (
  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showResetSent, setShowResetSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setIsLoading(true);

    try {
      const { session } = await signInWithEmail(email, password);
      if (session) {
        localStorage.setItem('supabase-access-token', session.access_token);
        onLoginSuccess();
      }
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address first');
      return;
    }

    setError('');
    setSuccess('');
    setIsLoading(true);

    try {
      await resetPassword(email.trim());
      setSuccess(`Password reset link sent to ${email.trim()}`);
      setShowResetSent(true);
    } catch (err) {
      setError(err.message || 'Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '28rem', zIndex: 10 }}>
        {/* Card */}
        <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '1rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', padding: '2rem', border: '1px solid rgba(255,255,255,0.2)' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
            <div style={{ background: 'linear-gradient(135deg, #2563eb, #4f46e5)', padding: '0.75rem', borderRadius: '0.5rem', color: 'white' }}>
              <MapIcon />
            </div>
          </div>

          <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold', textAlign: 'center', marginBottom: '0.5rem', color: '#111827' }}>Pineview Maps</h1>
          <p style={{ textAlign: 'center', color: '#6b7280', marginBottom: '2rem' }}>Field Mapping & Collaboration</p>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#374151', marginBottom: '0.5rem' }}>Email Address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                style={{ width: '100%', padding: '0.75rem 1rem', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '1rem', boxSizing: 'border-box', opacity: isLoading ? 0.5 : 1 }}
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#374151', marginBottom: '0.5rem' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                style={{ width: '100%', padding: '0.75rem 1rem', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '1rem', boxSizing: 'border-box', opacity: isLoading ? 0.5 : 1 }}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', fontSize: '0.875rem', color: '#b91c1c' }}>
                {error}
              </div>
            )}

            {success && (
              <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '0.5rem', fontSize: '0.875rem', color: '#166534' }}>
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading || showResetSent}
              style={{ width: '100%', background: isLoading ? '#9ca3af' : 'linear-gradient(90deg, #2563eb, #4f46e5)', color: 'white', fontWeight: 600, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none', fontSize: '1rem', cursor: isLoading || showResetSent ? 'default' : 'pointer' }}
            >
              {isLoading ? 'Loading...' : 'Sign In'}
            </button>

            {!showResetSent && (
              <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={isLoading}
                  style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.875rem', cursor: isLoading ? 'default' : 'pointer', textDecoration: 'underline' }}
                >
                  Forgot your password?
                </button>
              </div>
            )}
          </form>

          {/* Footer */}
          <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid #e5e7eb' }}>
            <p style={{ fontSize: '0.75rem', color: '#9ca3af', textAlign: 'center' }}>
              Secure authentication powered by Supabase
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
