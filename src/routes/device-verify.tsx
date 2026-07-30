import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import authService, { DeviceProgressEvent } from '../services/auth';
import { useThemeMode } from '../store/settings';
import AccountPortalPlainActions from '../components/account/AccountPortalPlainActions';
import '../styles/auth.css';

/**
 * The device security screen. Both flows live here: verifying an existing
 * device, and registering a new one when verification says it is unknown.
 *
 * Progress is REAL — main emits a event per step as it happens (including the
 * TPM steps) and we render exactly those. `skipped` is a normal outcome, shown
 * dimmed: a machine with no TPM legitimately has nothing to sign with and still
 * authenticates on its device secret alone.
 */
type StepState = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

interface Step {
  id: string;
  label: string;
}

const VERIFY_STEPS: Step[] = [
  { id: 'identify', label: 'Identifying' },
  { id: 'sign', label: 'Hardware key' },
  { id: 'validate', label: 'Validating' },
  { id: 'bind', label: 'Binding' },
  { id: 'secure', label: 'Securing' },
];

const REGISTER_STEPS: Step[] = [
  { id: 'identify', label: 'Identifying' },
  { id: 'profile', label: 'Hardware' },
  { id: 'sign', label: 'Hardware key' },
  { id: 'submit', label: 'Registering' },
  { id: 'check', label: 'Approval' },
];

/** A step counts toward the bar once it has finished, however it finished. */
const SETTLED: StepState[] = ['done', 'skipped', 'failed'];

const DeviceVerify: React.FC = () => {
  const navigate = useNavigate();
  const themeMode = useThemeMode();
  const isDark = themeMode === 'dark';
  const [status, setStatus] = useState<'verifying' | 'registering' | 'pending' | 'error' | 'tpm-mismatch'>('verifying');
  const [message, setMessage] = useState('Verifying device security...');
  const [error, setError] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Which bar is showing, and the state of each of its steps.
  const [phase, setPhase] = useState<'verify' | 'register'>('verify');
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [details, setDetails] = useState<Record<string, string>>({});

  // Progress events land on whichever phase main says they belong to, so the
  // handler must not close over the current phase state.
  const phaseRef = useRef<'verify' | 'register'>('verify');

  useEffect(() => {
    const onProgress = (event: DeviceProgressEvent) => {
      if (event.phase !== phaseRef.current) {
        return;
      }
      setSteps(prev => ({ ...prev, [event.step]: event.state }));
      if (event.detail) {
        setDetails(prev => ({ ...prev, [event.step]: event.detail as string }));
      }
    };

    authService.onDeviceProgress(onProgress);
    verifyDevice();

    return () => authService.offDeviceProgress(onProgress);
  }, []);

  /** Switch bars and clear the previous one's step state. */
  const beginPhase = (next: 'verify' | 'register') => {
    phaseRef.current = next;
    setPhase(next);
    setSteps({});
    setDetails({});
  };

  const verifyDevice = async () => {
    try {
      await authService.verifyDevice();
      setMessage('Device verified successfully');

      // Device verification is the finish line — full access. Enter the app.
      setTimeout(() => {
        navigate('/signed-in-landing/home');
      }, 400);
    } catch (err: any) {
      if (
        err.message === 'DEVICE_NOT_REGISTERED' ||
        err.message === 'DEVICE_SECRET_INVALID'
      ) {
        // Not registered, or hardware changed (secret invalid) -> (re-)register.
        beginPhase('register');
        setStatus('registering');
        setMessage('Registering new device...');
        await registerDevice();
      } else if (err.message === 'DEVICE_TPM_MISMATCH') {
        // The server holds a sealed key this machine can no longer satisfy.
        // Re-registering cannot fix it — there is no unbind endpoint.
        setStatus('tpm-mismatch');
        setMessage('Hardware Security Mismatch');
        setDeviceId(authService.getDeviceId());
      } else if (err.message?.includes('pending') || err.message?.includes('approval')) {
        // Device is already registered but pending approval
        setStatus('pending');
        setMessage('Device Registered - Awaiting Approval');
        setError('');
        setDeviceId(authService.getDeviceId());
      } else {
        setStatus('error');
        setError(err.message || 'Device verification failed');
      }
    }
  };

  const registerDevice = async () => {
    try {
      const result = await authService.registerDevice();

      // Store device ID for display
      setDeviceId(result.deviceId);

      // After registration, immediately try to verify
      // If approved, verification will succeed
      // If pending, verification will fail with appropriate message
      setMessage('Checking device approval status...');

      try {
        await authService.verifyDevice({ phase: 'register' });
        setMessage('Device approved and verified');
        setTimeout(() => {
          navigate('/signed-in-landing/home');
        }, 400);
      } catch (verifyErr: any) {
        // Device is registered but not approved yet
        if (verifyErr.message?.includes('pending') || verifyErr.message?.includes('approval')) {
          setStatus('pending');
          setMessage('Device Registered - Awaiting Approval');
          setError(''); // Clear error since we're showing structured info below
        } else {
          throw verifyErr; // Re-throw unexpected errors
        }
      }
    } catch (err: any) {
      setStatus('error');
      setError(err.message || 'Device registration failed');
    }
  };

  const retry = () => {
    beginPhase('verify');
    setStatus('verifying');
    setMessage('Verifying device security...');
    setError('');
    verifyDevice();
  };

  const activeSteps = phase === 'register' ? REGISTER_STEPS : VERIFY_STEPS;
  const settledCount = activeSteps.filter(s => SETTLED.includes(steps[s.id])).length;
  const progress = Math.round((settledCount / activeSteps.length) * 100);

  return (
    <div className={`auth-container${isDark ? ' theme-dark' : ''}`}>
      <div className="auth-card device-verify">
        <div className={`device-icon ${status}`}>
          {status === 'error' || status === 'tpm-mismatch' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="#FF3B30" strokeWidth="2" opacity="0.3"/>
              <path d="M50 30L30 50M30 30L50 50" stroke="#FF3B30" strokeWidth="3" strokeLinecap="round"/>
            </svg>
          ) : status === 'pending' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="#FF9500" strokeWidth="2" opacity="0.3"/>
              <path d="M40 25v20M40 55v.01" stroke="#FF9500" strokeWidth="3" strokeLinecap="round"/>
            </svg>
          ) : (
            <div className="device-animation">
              <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="device-shield">
                <path d="M40 10L15 22v20c0 13.255 10.745 28 25 28s25-14.745 25-28V22L40 10z"
                      stroke="url(#deviceGradient)" strokeWidth="2" fill="none" opacity="0.3"/>
                <path d="M30 40l8 8 16-16" stroke="url(#deviceGradient)" strokeWidth="3"
                      strokeLinecap="round" strokeLinejoin="round"
                      className={progress === 100 ? 'check-mark' : ''} />
                <defs>
                  <linearGradient id="deviceGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="var(--primary-blue)" />
                    <stop offset="100%" stopColor="var(--primary-purple)" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="pulse-ring" />
            </div>
          )}
        </div>

        <h2 className="auth-title">{status === 'pending' ? 'Awaiting Approval' : 'Device Security'}</h2>
        <p className="auth-subtitle">{message}</p>

        {status === 'verifying' || status === 'registering' ? (
          <div className="progress-container">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-steps">
              {activeSteps.map(step => {
                const state = steps[step.id] || 'pending';
                // 'active' keeps the lit styling of the old bar; the settled
                // states add their own modifier on top.
                const lit = state !== 'pending' ? 'active' : '';
                return (
                  <div key={step.id} className={`step ${lit} ${state}`}>
                    <span className="step-dot" />
                    <span className="step-label">{step.label}</span>
                    {details[step.id] && (
                      <span className="step-detail">{details[step.id]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {error && status === 'error' && (
          <>
            <div className="error-message device-error">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1C4.134 1 1 4.134 1 8s3.134 7 7 7 7-3.134 7-7-3.134-7-7-7zm0 12.5c-.414 0-.75-.336-.75-.75s.336-.75.75-.75.75.336.75.75-.336.75-.75.75zm.75-3.5c0 .414-.336.75-.75.75s-.75-.336-.75-.75V5c0-.414.336-.75.75-.75s.75.336.75.75v5z"/>
              </svg>
              {error}
            </div>
            <button onClick={retry} className="submit-button retry-button">
              Try Again
            </button>
          </>
        )}

        {status === 'pending' && (
          <div className="pending-message">
            <div className="info-box">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="#FF9500">
                <path d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm1 15h-2v-2h2v2zm0-4h-2V5h2v6z"/>
              </svg>
              <div>
                <p style={{ marginBottom: '12px', fontWeight: 600 }}>Device Registered</p>
                <p style={{ marginBottom: '16px' }}>Your administrator has been notified and will review your request.</p>
                <DeviceIdField deviceId={deviceId} isDark={isDark} />
                <p style={{ fontSize: '13px', opacity: 0.7, marginBottom: '8px' }}>
                  You can share this ID with your approver if needed.
                </p>
                <p style={{ fontSize: '14px', opacity: 0.8 }}>You'll be able to sign in once your device is approved.</p>
                {/* Until this device is approved the app can't reach the access
                    API at all, so Atlas is the only place the user can watch
                    the request or chase whoever approves it. */}
                <AccountPortalPlainActions label="Check status on Atlas" isDark={isDark} />
              </div>
            </div>
            <button onClick={() => navigate('/')} className="submit-button" style={{ marginTop: '16px' }}>
              Back to Login
            </button>
          </div>
        )}

        {status === 'tpm-mismatch' && (
          <div className="pending-message">
            <div className="info-box">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="#FF3B30">
                <path d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm1 15h-2v-2h2v2zm0-4h-2V5h2v6z"/>
              </svg>
              <div>
                <p style={{ marginBottom: '12px', fontWeight: 600 }}>Hardware security key no longer matches</p>
                <p style={{ marginBottom: '16px' }}>
                  This device is registered with a hardware key that its security chip can no
                  longer produce — usually the result of a TPM reset, a firmware update or a
                  motherboard change.
                </p>
                <p style={{ marginBottom: '16px' }}>
                  For safety this cannot be re-bound automatically. Your administrator needs to
                  remove this device so it can be registered again.
                </p>
                <DeviceIdField deviceId={deviceId} isDark={isDark} />
                <p style={{ fontSize: '13px', opacity: 0.7 }}>
                  Send this ID to your approver.
                </p>
                <AccountPortalPlainActions label="Manage devices on Atlas" isDark={isDark} />
              </div>
            </div>
            <button onClick={() => navigate('/')} className="submit-button" style={{ marginTop: '16px' }}>
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/** Monospace device ID with a copy button — shown on both terminal cards. */
const DeviceIdField: React.FC<{ deviceId: string | null; isDark: boolean }> = ({
  deviceId,
  isDark,
}) => (
  <>
    <p style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 500 }}>Device ID</p>
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '12px',
      background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)',
      borderRadius: '8px',
      fontFamily: 'monospace',
      fontSize: '14px',
      marginBottom: '12px'
    }}>
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{deviceId}</span>
      <button
        onClick={() => {
          if (deviceId) {
            navigator.clipboard.writeText(deviceId);
            // Optional: Add a toast notification here
          }
        }}
        style={{
          padding: '6px 12px',
          background: 'var(--primary-blue)',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '12px',
          whiteSpace: 'nowrap'
        }}
      >
        Copy
      </button>
    </div>
  </>
);

export default DeviceVerify;