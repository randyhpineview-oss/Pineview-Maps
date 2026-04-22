import { useState } from 'react';
import { api } from '../lib/api';

const MapIcon = () => (
  <svg style={{ width: '2rem', height: '2rem' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

/**
 * Gated worker self-signup form.
 *
 * Rendered by App.jsx when `?invite=<secret>` is present in the URL and no
 * session is active. Submits to POST /api/auth/signup. The backend validates
 * the invite_code against SIGNUP_INVITE_SECRET, forces role="worker", creates
 * the Supabase user with email_confirm=False, and emails the confirmation
 * link via our Gmail SMTP. On success we show a "check your email" screen.
 */
export default function SignupPage({ inviteCode, onDone }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      setError('Please enter your full name.');
      return;
    }
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      await api.signupWithInvite({
        invite_code: inviteCode,
        name: trimmedName,
        email: trimmedEmail,
        password,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'Could not create account. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setSubmitted(false);
    setError('');
    if (onDone) onDone();
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '28rem', zIndex: 10 }}>
        <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '1rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', padding: '2rem', border: '1px solid rgba(255,255,255,0.2)' }}>
          {submitted ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div style={{
                width: '64px',
                height: '64px',
                background: '#dcfce7',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 1.5rem',
              }}>
                <svg style={{ width: '32px', height: '32px', color: '#16a34a' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', color: '#111827' }}>
                Check your email
              </h2>
              <p style={{ color: '#6b7280', marginBottom: '1.5rem', lineHeight: 1.5 }}>
                We've sent a confirmation link to <strong>{email}</strong>.
                Click it to activate your account, then come back here to log in.
              </p>
              <p style={{ color: '#9ca3af', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
                Didn't get it? Check your spam folder. The link expires in 24 hours.
              </p>
              <button
                type="button"
                onClick={handleBackToLogin}
                style={{
                  background: 'linear-gradient(90deg, #2563eb, #4f46e5)',
                  color: 'white',
                  fontWeight: 600,
                  padding: '0.75rem 1.5rem',
                  borderRadius: '0.5rem',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.95rem',
                }}
              >
                Back to Login
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
                <div style={{ background: 'linear-gradient(135deg, #2563eb, #4f46e5)', padding: '0.75rem', borderRadius: '0.5rem', color: 'white' }}>
                  <MapIcon />
                </div>
              </div>
              <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold', textAlign: 'center', marginBottom: '0.5rem', color: '#111827' }}>
                Join Pineview Maps
              </h1>
              <p style={{ textAlign: 'center', color: '#6b7280', marginBottom: '2rem' }}>
                Create your worker account
              </p>

              {error && (
                <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', fontSize: '0.875rem', color: '#b91c1c', marginBottom: '1.25rem' }}>
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                    Full name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Jane Doe"
                    autoComplete="name"
                    disabled={isLoading}
                    required
                    style={{ width: '100%', padding: '0.625rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '0.95rem', boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                    Email address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    disabled={isLoading}
                    required
                    style={{ width: '100%', padding: '0.625rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '0.95rem', boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    autoComplete="new-password"
                    disabled={isLoading}
                    required
                    minLength={6}
                    style={{ width: '100%', padding: '0.625rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '0.95rem', boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                    Confirm password
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    autoComplete="new-password"
                    disabled={isLoading}
                    required
                    minLength={6}
                    style={{ width: '100%', padding: '0.625rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '0.95rem', boxSizing: 'border-box' }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  style={{
                    background: 'linear-gradient(90deg, #2563eb, #4f46e5)',
                    color: 'white',
                    fontWeight: 600,
                    padding: '0.75rem',
                    borderRadius: '0.5rem',
                    border: 'none',
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    fontSize: '0.95rem',
                    marginTop: '0.5rem',
                    opacity: isLoading ? 0.7 : 1,
                  }}
                >
                  {isLoading ? 'Creating account…' : 'Create account'}
                </button>

                <button
                  type="button"
                  onClick={handleBackToLogin}
                  disabled={isLoading}
                  style={{
                    background: 'transparent',
                    color: '#6b7280',
                    fontWeight: 500,
                    padding: '0.5rem',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                    textAlign: 'center',
                  }}
                >
                  Already have an account? Log in
                </button>
              </form>
            </>
          )}

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
