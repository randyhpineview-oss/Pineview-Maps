import { useState, useRef } from 'react';
import { signInWithEmail } from '../lib/supabaseClient';
import { api } from '../lib/api';

const MapIcon = () => (
  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

// 6-digit code input component
const CodeInput = ({ value, onChange, disabled }) => {
  const inputsRef = useRef([]);

  const handleChange = (index, digit) => {
    if (!/^\d*$/.test(digit)) return;
    const newValue = value.split('');
    newValue[index] = digit.slice(-1);
    const newCode = newValue.join('').slice(0, 6);
    onChange(newCode);
    if (digit && index < 5) {
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    onChange(pasted);
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }} onPaste={handlePaste}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <input
          key={i}
          ref={(el) => (inputsRef.current[i] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[i] || ''}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          style={{
            width: '3rem',
            height: '3.5rem',
            textAlign: 'center',
            fontSize: '1.5rem',
            fontWeight: '600',
            border: '2px solid #d1d5db',
            borderRadius: '0.5rem',
            background: '#f9fafb',
            opacity: disabled ? 0.5 : 1,
          }}
        />
      ))}
    </div>
  );
};

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [resetFlow, setResetFlow] = useState('idle');
  const [resetCode, setResetCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

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

  const handleRequestCode = async () => {
    if (!email.trim()) {
      setError('Please enter your email address first');
      return;
    }
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      await api.requestResetCode(email.trim());
      setSuccess('Check your email! We\'ve sent a 6-digit reset code.');
      setResetFlow('entering_code');
      setResetCode('');
    } catch (err) {
      setError(err.message || 'Failed to send reset code');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    if (resetCode.length !== 6) {
      setError('Please enter all 6 digits');
      return;
    }
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      const response = await api.verifyResetCode(email.trim(), resetCode);
      setResetToken(response.reset_token);
      setSuccess('Code verified! Now enter your new password.');
      setResetFlow('entering_password');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message || 'Invalid code');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      await api.resetPasswordWithToken(resetToken, newPassword);
      setSuccess('Password reset successfully! You can now log in.');
      setResetFlow('success');
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setResetCode('');
    } catch (err) {
      setError(err.message || 'Failed to reset password');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setResetFlow('idle');
    setResetCode('');
    setResetToken('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setSuccess('');
  };

  const startForgotPassword = () => {
    if (!email.trim()) {
      setError('Please enter your email address first');
      return;
    }
    setResetFlow('requesting');
    setError('');
    setSuccess('');
  };

  const renderContent = () => {
    if (resetFlow === 'success') {
      return (
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
            Password Reset Complete
          </h2>
          <p style={{ color: '#6b7280', marginBottom: '1.5rem' }}>
            Your password has been reset successfully.
          </p>
          <button
            onClick={handleBackToLogin}
            style={{
              background: 'linear-gradient(90deg, #2563eb, #4f46e5)',
              color: 'white',
              fontWeight: 600,
              padding: '0.75rem 1.5rem',
              borderRadius: '0.5rem',
              border: 'none',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            Back to Login
          </button>
        </div>
      );
    }

    if (resetFlow === 'entering_password') {
      return (
        <form onSubmit={handleResetPassword} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#374151', marginBottom: '0.5rem' }}>
              New Password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              disabled={isLoading}
              minLength={6}
              autoFocus
              style={{ width: '100%', padding: '0.75rem 1rem', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '1rem', boxSizing: 'border-box', opacity: isLoading ? 0.5 : 1 }}
              placeholder="Enter new password"
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#374151', marginBottom: '0.5rem' }}>
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isLoading}
              minLength={6}
              style={{ width: '100%', padding: '0.75rem 1rem', background: '#f9fafb', border: '1px solid #d1d5db', borderRadius: '0.5rem', fontSize: '1rem', boxSizing: 'border-box', opacity: isLoading ? 0.5 : 1 }}
              placeholder="Confirm new password"
            />
          </div>
          <button
            type="submit"
            disabled={isLoading}
            style={{ width: '100%', background: isLoading ? '#9ca3af' : 'linear-gradient(90deg, #2563eb, #4f46e5)', color: 'white', fontWeight: 600, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none', fontSize: '1rem', cursor: isLoading ? 'default' : 'pointer' }}
          >
            {isLoading ? 'Resetting...' : 'Reset Password'}
          </button>
          <button
            type="button"
            onClick={handleBackToLogin}
            disabled={isLoading}
            style={{ width: '100%', background: 'transparent', color: '#6b7280', fontWeight: 500, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: '1px solid #d1d5db', fontSize: '1rem', cursor: isLoading ? 'default' : 'pointer' }}
          >
            Cancel
          </button>
        </form>
      );
    }

    if (resetFlow === 'entering_code') {
      return (
        <form onSubmit={handleVerifyCode} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, color: '#374151', marginBottom: '1rem', textAlign: 'center' }}>
              Enter the 6-digit code sent to<br />
              <strong style={{ color: '#2563eb' }}>{email}</strong>
            </label>
            <CodeInput value={resetCode} onChange={setResetCode} disabled={isLoading} />
            <p style={{ fontSize: '0.75rem', color: '#6b7280', textAlign: 'center', marginTop: '0.75rem' }}>
              Code expires in 10 minutes
            </p>
          </div>
          <button
            type="submit"
            disabled={isLoading || resetCode.length !== 6}
            style={{ width: '100%', background: (isLoading || resetCode.length !== 6) ? '#9ca3af' : 'linear-gradient(90deg, #2563eb, #4f46e5)', color: 'white', fontWeight: 600, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none', fontSize: '1rem', cursor: (isLoading || resetCode.length !== 6) ? 'default' : 'pointer' }}
          >
            {isLoading ? 'Verifying...' : 'Verify Code'}
          </button>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={handleRequestCode}
              disabled={isLoading}
              style={{ flex: 1, background: 'transparent', color: '#2563eb', fontWeight: 500, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: '1px solid #2563eb', fontSize: '0.875rem', cursor: isLoading ? 'default' : 'pointer' }}
            >
              Resend Code
            </button>
            <button
              type="button"
              onClick={handleBackToLogin}
              disabled={isLoading}
              style={{ flex: 1, background: 'transparent', color: '#6b7280', fontWeight: 500, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: '1px solid #d1d5db', fontSize: '0.875rem', cursor: isLoading ? 'default' : 'pointer' }}
            >
              Back
            </button>
          </div>
        </form>
      );
    }

    if (resetFlow === 'requesting') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <p style={{ color: '#4b5563', marginBottom: '1rem' }}>
              We'll send a 6-digit reset code to:
            </p>
            <p style={{ fontSize: '1.125rem', fontWeight: 600, color: '#111827', marginBottom: '1.5rem' }}>
              {email}
            </p>
          </div>
          <button
            onClick={handleRequestCode}
            disabled={isLoading}
            style={{ width: '100%', background: isLoading ? '#9ca3af' : 'linear-gradient(90deg, #2563eb, #4f46e5)', color: 'white', fontWeight: 600, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none', fontSize: '1rem', cursor: isLoading ? 'default' : 'pointer' }}
          >
            {isLoading ? 'Sending...' : 'Send Reset Code'}
          </button>
          <button
            onClick={handleBackToLogin}
            disabled={isLoading}
            style={{ width: '100%', background: 'transparent', color: '#6b7280', fontWeight: 500, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: '1px solid #d1d5db', fontSize: '1rem', cursor: isLoading ? 'default' : 'pointer' }}
          >
            Back to Login
          </button>
        </div>
      );
    }

    return (
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
        <button
          type="submit"
          disabled={isLoading}
          style={{ width: '100%', background: isLoading ? '#9ca3af' : 'linear-gradient(90deg, #2563eb, #4f46e5)', color: 'white', fontWeight: 600, padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none', fontSize: '1rem', cursor: isLoading ? 'default' : 'pointer' }}
        >
          {isLoading ? 'Loading...' : 'Sign In'}
        </button>
        <div style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button
            type="button"
            onClick={startForgotPassword}
            disabled={isLoading}
            style={{ background: 'none', border: 'none', color: '#2563eb', fontSize: '0.875rem', cursor: isLoading ? 'default' : 'pointer', textDecoration: 'underline' }}
          >
            Forgot your password?
          </button>
        </div>
      </form>
    );
  };

  const getHeader = () => {
    switch (resetFlow) {
      case 'requesting':
        return { title: 'Reset Password', subtitle: 'Confirm your email address' };
      case 'entering_code':
        return { title: 'Enter Reset Code', subtitle: 'Check your email for the 6-digit code' };
      case 'entering_password':
        return { title: 'New Password', subtitle: 'Create a new password for your account' };
      case 'success':
        return { title: '', subtitle: '' };
      default:
        return { title: 'Pineview Maps', subtitle: 'Field Mapping & Collaboration' };
    }
  };

  const header = getHeader();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '28rem', zIndex: 10 }}>
        <div style={{ background: 'rgba(255,255,255,0.95)', borderRadius: '1rem', boxShadow: '0 25px 50px rgba(0,0,0,0.25)', padding: '2rem', border: '1px solid rgba(255,255,255,0.2)' }}>
          {resetFlow !== 'success' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
                <div style={{ background: 'linear-gradient(135deg, #2563eb, #4f46e5)', padding: '0.75rem', borderRadius: '0.5rem', color: 'white' }}>
                  <MapIcon />
                </div>
              </div>
              <h1 style={{ fontSize: '1.875rem', fontWeight: 'bold', textAlign: 'center', marginBottom: '0.5rem', color: '#111827' }}>{header.title}</h1>
              <p style={{ textAlign: 'center', color: '#6b7280', marginBottom: '2rem' }}>{header.subtitle}</p>
            </>
          )}
          {error && (
            <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', fontSize: '0.875rem', color: '#b91c1c', marginBottom: '1.25rem' }}>
              {error}
            </div>
          )}
          {success && (
            <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '0.5rem', fontSize: '0.875rem', color: '#166534', marginBottom: '1.25rem' }}>
              {success}
            </div>
          )}
          {renderContent()}
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
