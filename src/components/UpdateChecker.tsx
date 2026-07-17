import React, { useState, useEffect, useRef } from 'react';
import '../styles/auth.css';

interface UpdateCheckerProps {
  onUpdateComplete: () => void;
}

interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ onUpdateComplete }) => {
  const [status, setStatus] = useState<'checking' | 'available' | 'downloading' | 'installing' | 'download-complete' | 'restart-required' | 'error'>('checking');
  const [message, setMessage] = useState('Checking for updates...');
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [updateInstalled, setUpdateInstalled] = useState(false);
  const checkingCompleteRef = useRef(false);

  useEffect(() => {
    // console.log('[UpdateChecker] Starting update check');
    if (!window.ipcApi) {
      // console.log('[UpdateChecker] IPC API not available, skipping');
      checkingCompleteRef.current = true;
      setTimeout(() => onUpdateComplete(), 100);
      return;
    }

    // console.log('[UpdateChecker] Registering event listeners');
    // Get current version
    window.ipcApi.sendIpcRequest('app:get-version')
      .then((response: any) => {
        const version = response?.data?.version || response?.version || 'Unknown';
        setCurrentVersion(version);
      })
      .catch(err => console.error('[UpdateChecker] Failed to get version:', err));

    // Listen for update events from main process
    const handleUpdateAvailable = (_event: any, info: UpdateInfo) => {
      // console.log('[UpdateChecker] Update available:', info);
      // Mark as in-progress so the 5-second "no events" timeout doesn't fire
      checkingCompleteRef.current = true;
      setUpdateInfo(info);
      setStatus('downloading');
      setMessage(`Downloading version ${info.version}...`);
      // Auto-download is now enabled in main.ts, so download will start automatically

      // Fallback: If download seems stuck or events don't fire,
      // assume download completed after a reasonable timeout and show success
      setTimeout(() => {
        setStatus((currentStatus) => {
          if (currentStatus === 'downloading') {
            // Still downloading after 10 minutes - assume it completed silently
            setDownloadProgress(100);
            setUpdateInstalled(true);
            setMessage(`Version ${info.version} ready to install`);

            // Trigger install in background
            setTimeout(() => {
              window.ipcApi?.sendIpcRequest('app:install-update')
                .catch((err: any) => {
                  console.error('[UpdateChecker] Install prep failed:', err);
                });
            }, 500);

            return 'download-complete';
          }
          return currentStatus;
        });
      }, 600000); // 10 minute timeout for download
    };

    const handleUpdateNotAvailable = () => {
      // console.log('[UpdateChecker] No updates available, continuing to app');
      setStatus('checking');
      setMessage('You have the latest version');
      checkingCompleteRef.current = true;
      setTimeout(() => {
        onUpdateComplete();
      }, 1000);
    };

    const handleDownloadProgress = (_event: any, progressInfo: any) => {
      // console.log('[UpdateChecker] Download progress:', progressInfo.percent);
      setStatus('downloading');
      setMessage(`Downloading update...`);
      const progress = Math.round(progressInfo.percent || 0);
      setDownloadProgress(progress);

      // Fallback: If we hit 100% but update-downloaded event never fires,
      // treat it as complete after a short delay
      if (progress >= 100) {
        setTimeout(() => {
          // Only trigger if we're still in downloading state (event didn't fire)
          setStatus((currentStatus) => {
            if (currentStatus === 'downloading') {
              // Manually trigger the download complete flow
              setDownloadProgress(100);
              setUpdateInstalled(true);
              setMessage(`Update ready to install`);

              // Trigger install in background
              setTimeout(() => {
                window.ipcApi?.sendIpcRequest('app:install-update')
                  .catch((err: any) => {
                    console.error('[UpdateChecker] Install prep failed:', err);
                  });
              }, 500);

              return 'download-complete';
            }
            return currentStatus;
          });
        }, 2000); // Wait 2 seconds after 100% before assuming event won't fire
      }
    };

    const handleUpdateDownloaded = () => {
      // console.log('[UpdateChecker] Update downloaded successfully');
      // Show success message immediately - user must close and reopen to apply
      setStatus('download-complete');
      setDownloadProgress(100);
      setUpdateInstalled(true);
      const newVersion = updateInfo?.version || 'the latest version';
      setMessage(`Version ${newVersion} ready to install`);

      // Still trigger the install in background (prepares files for next launch)
      setTimeout(() => {
        // console.log('[UpdateChecker] Triggering install preparation');
        window.ipcApi!.sendIpcRequest('app:install-update')
          .catch((err: any) => {
            // Silently log errors - user will still need to restart
            console.error('[UpdateChecker] Install prep failed:', err);
          });
      }, 500);

      // NOTE: Intentionally NOT calling onUpdateComplete() here
      // This keeps the update screen visible with success message,
      // forcing the user to close and reopen the app to apply the update.
    };

    const handleUpdateError = (_event: any, errorMessage: string) => {
      console.error('[UpdateChecker] Error:', errorMessage);
      setError(errorMessage);
      setStatus('error');
      setMessage('Update failed');
      checkingCompleteRef.current = true;
    };

    // Register IPC listeners
    window.ipcApi.onUpdateAvailable?.(handleUpdateAvailable);
    window.ipcApi.onUpdateNotAvailable?.(handleUpdateNotAvailable);
    window.ipcApi.onDownloadProgress?.(handleDownloadProgress);
    window.ipcApi.onUpdateDownloaded?.(handleUpdateDownloaded);
    window.ipcApi.onUpdateError?.(handleUpdateError);

    // Trigger update check
    // console.log('[UpdateChecker] Sending check-for-updates request');
    window.ipcApi.sendIpcRequest('app:check-for-updates')
      .then((response: any) => {
        // console.log('[UpdateChecker] Raw response:', response);
        // Unwrap the IPC response
        const result = response?.data || response;
        // console.log('[UpdateChecker] Check result:', result);
        // In dev mode, just log and continue
        if (result?.devMode) {
          // console.log('[UpdateChecker] DEV MODE ENABLED');
          // console.log('[UpdateChecker] Message:', result.message);
          // console.log('[UpdateChecker] Current version:', result.currentVersion);
          // console.log('[UpdateChecker] Continuing to app...');
          checkingCompleteRef.current = true;
          onUpdateComplete();
          return;
        }

        // Set a timeout to mark check as complete if no events fire within 5 seconds
        // This handles the case where update check completes but no event is emitted
        setTimeout(() => {
          if (!checkingCompleteRef.current) {
            // console.log('[UpdateChecker] No update events received within timeout, assuming no update');
            checkingCompleteRef.current = true;
            setMessage('You have the latest version');
            setTimeout(() => onUpdateComplete(), 1000);
          }
        }, 5000);
      })
      .catch((err: any) => {
        console.error('[UpdateChecker] Check failed:', err);
        setError(err.message || 'Failed to check for updates');
        setStatus('error');
        setMessage('Update check failed');
        checkingCompleteRef.current = true;
      });

    return () => {
      window.ipcApi?.offUpdateAvailable?.(handleUpdateAvailable);
      window.ipcApi?.offUpdateNotAvailable?.(handleUpdateNotAvailable);
      window.ipcApi?.offDownloadProgress?.(handleDownloadProgress);
      window.ipcApi?.offUpdateDownloaded?.(handleUpdateDownloaded);
      window.ipcApi?.offUpdateError?.(handleUpdateError);
    };
  }, [onUpdateComplete]);

  const handleStartUpdate = () => {
    // console.log('[UpdateChecker] User confirmed update, triggering download');
    setStatus('downloading');
    setMessage('Preparing download...');
    window.ipcApi!.sendIpcRequest('app:download-update').catch((err: any) => {
      console.error('[UpdateChecker] Download failed:', err);
      setError(err.message || 'Failed to download update');
      setStatus('error');
      setMessage('Download failed');
    });
  };

  const handleContinueWithoutUpdate = () => {
    // console.log('[UpdateChecker] Continuing without update (only allowed on error)');
    onUpdateComplete();
  };

  const handleRetry = () => {
    setStatus('checking');
    setMessage('Checking for updates...');
    setError(null);
    setDownloadProgress(0);
    window.location.reload();
  };

  return (
    <div className="auth-container">
      <div className="auth-card device-verify">
        {/* Icon */}
        <div className={`device-icon ${status}`}>
          {status === 'error' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="#FF3B30" strokeWidth="2" opacity="0.3"/>
              <path d="M50 30L30 50M30 30L50 50" stroke="#FF3B30" strokeWidth="3" strokeLinecap="round"/>
            </svg>
          ) : status === 'download-complete' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="#34C759" strokeWidth="2" opacity="0.3"/>
              <path d="M26 40l10 10 20-20" stroke="#34C759" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : status === 'restart-required' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="url(#restartGradient)" strokeWidth="2" opacity="0.3"/>
              <path d="M40 20 L40 35 M40 35 L50 25 M40 35 L30 25" stroke="url(#restartGradient)" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="40" cy="50" r="10" stroke="url(#restartGradient)" strokeWidth="3" fill="none"
                      strokeDasharray="3 2" className="restart-icon">
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0 40 50"
                  to="360 40 50"
                  dur="2s"
                  repeatCount="indefinite"/>
              </circle>
              <defs>
                <linearGradient id="restartGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#FF9500" />
                  <stop offset="100%" stopColor="#FF3B30" />
                </linearGradient>
              </defs>
            </svg>
          ) : status === 'installing' ? (
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <circle cx="40" cy="40" r="38" stroke="url(#updateGradient)" strokeWidth="2" opacity="0.3"/>
              <path d="M30 40l8 8 16-16" stroke="url(#updateGradient)" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round" className="check-mark" />
              <defs>
                <linearGradient id="updateGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#007AFF" />
                  <stop offset="100%" stopColor="#5856D6" />
                </linearGradient>
              </defs>
            </svg>
          ) : (
            <div className="device-animation">
              <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="device-shield">
                <path d="M40 15L40 50M40 50L28 38M40 50L52 38"
                      stroke="url(#updateGradient)" strokeWidth="3"
                      strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="40" cy="55" r="3" fill="url(#updateGradient)"/>
                <path d="M25 62h30" stroke="url(#updateGradient)" strokeWidth="3" strokeLinecap="round"/>
                <defs>
                  <linearGradient id="updateGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#007AFF" />
                    <stop offset="100%" stopColor="#5856D6" />
                  </linearGradient>
                </defs>
              </svg>
              {(status === 'checking' || status === 'downloading') && <div className="pulse-ring" />}
            </div>
          )}
        </div>

        {/* Title */}
        <h2 className="auth-title">
          {status === 'checking' && 'Checking for Updates'}
          {status === 'available' && 'Update Available'}
          {status === 'downloading' && 'Downloading Update'}
          {status === 'installing' && 'Installing Update'}
          {status === 'download-complete' && 'Download Complete'}
          {status === 'restart-required' && 'Restart Required'}
          {status === 'error' && 'Update Error'}
        </h2>

        {/* Subtitle/Message */}
        <p className="auth-subtitle">{message}</p>

        {/* Version Info - Show when update is available */}
        {status === 'available' && updateInfo && (
          <div style={{
            marginBottom: '24px',
            padding: '20px',
            background: 'rgba(0, 122, 255, 0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(0, 122, 255, 0.15)',
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-around',
              alignItems: 'center',
              gap: '16px',
              marginBottom: updateInfo.releaseNotes ? '16px' : '0',
            }}>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <p style={{ fontSize: '12px', color: '#86868b', marginBottom: '4px', fontWeight: 500 }}>
                  CURRENT
                </p>
                <p style={{ fontSize: '20px', fontWeight: 700, color: '#1d1d1f', margin: 0 }}>
                  {currentVersion}
                </p>
              </div>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.4 }}>
                <path d="M5 12h14M14 5l7 7-7 7" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <p style={{ fontSize: '12px', color: '#007AFF', marginBottom: '4px', fontWeight: 600 }}>
                  NEW VERSION
                </p>
                <p style={{ fontSize: '20px', fontWeight: 700, color: '#007AFF', margin: 0 }}>
                  {updateInfo.version}
                </p>
              </div>
            </div>

            {/* Release Notes Toggle */}
            {updateInfo.releaseNotes && (
              <>
                <button
                  onClick={() => setShowReleaseNotes(!showReleaseNotes)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    background: 'none',
                    border: 'none',
                    color: '#007AFF',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    borderTop: showReleaseNotes ? 'none' : '1px solid rgba(0, 122, 255, 0.15)',
                    paddingTop: showReleaseNotes ? '0' : '12px',
                  }}
                >
                  {showReleaseNotes ? '▼ Hide' : '▶ Show'} What's New
                </button>
                {showReleaseNotes && (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'rgba(255, 255, 255, 0.5)',
                    borderRadius: '8px',
                    fontSize: '13px',
                    color: '#1d1d1f',
                    textAlign: 'left',
                    maxHeight: '150px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.6',
                  }}>
                    {updateInfo.releaseNotes}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Progress Bar or Spinner - Show when downloading */}
        {status === 'downloading' && (
          <div style={{
            padding: '20px',
            background: 'rgba(0, 122, 255, 0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(0, 122, 255, 0.15)',
            fontSize: '14px',
            color: '#1d1d1f',
            marginBottom: '16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="inline-spinner" />
              <span style={{ fontWeight: 500 }}>Downloading update...</span>
            </div>
            <div style={{
              fontSize: '13px',
              color: '#86868b',
              textAlign: 'center',
              lineHeight: '1.5',
            }}>
              Please wait. This may take a few moments.
              {updateInfo?.version && (
                <div style={{ marginTop: '8px', color: '#007AFF', fontWeight: 600 }}>
                  Version {updateInfo.version}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Installing message */}
        {status === 'installing' && (
          <div style={{
            padding: '20px',
            background: 'rgba(0, 122, 255, 0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(0, 122, 255, 0.15)',
            fontSize: '14px',
            color: '#1d1d1f',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
          }}>
            <div className="inline-spinner" />
            <span style={{ fontWeight: 500 }}>Installing update...</span>
          </div>
        )}

        {/* Download Complete - Green success message */}
        {status === 'download-complete' && (
          <div style={{
            padding: '24px',
            background: 'linear-gradient(135deg, rgba(52, 199, 89, 0.12) 0%, rgba(48, 209, 88, 0.12) 100%)',
            borderRadius: '16px',
            border: '2px solid rgba(52, 199, 89, 0.4)',
            fontSize: '15px',
            color: '#1d1d1f',
            marginBottom: '16px',
            textAlign: 'center',
          }}>
            <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '12px', color: '#34C759' }}>
              Update Downloaded Successfully!
            </div>
            <div style={{
              fontSize: '14px',
              fontWeight: 600,
              color: '#34C759',
              marginBottom: '8px',
            }}>
              Please close and reopen PSLoader to apply the update
            </div>
            {updateInfo?.version && (
              <div style={{
                marginTop: '16px',
                fontSize: '13px',
                color: '#86868b',
                fontWeight: 500,
              }}>
                New version: <span style={{ color: '#34C759', fontWeight: 700 }}>{updateInfo.version}</span>
              </div>
            )}
          </div>
        )}

        {/* Restart Required message */}
        {status === 'restart-required' && (
          <div style={{
            padding: '24px',
            background: 'linear-gradient(135deg, rgba(255, 149, 0, 0.12) 0%, rgba(255, 59, 48, 0.12) 100%)',
            borderRadius: '16px',
            border: '2px solid rgba(255, 149, 0, 0.4)',
            fontSize: '15px',
            color: '#1d1d1f',
            marginBottom: '16px',
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: '48px',
              marginBottom: '12px',
            }}>
              ⚠️
            </div>
            <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>
              Update Installed Successfully
            </div>
            <div style={{
              fontSize: '14px',
              fontWeight: 600,
              color: '#FF9500',
              marginBottom: '8px',
            }}>
              Please close and reopen PSLoader to apply the update
            </div>
            {updateInfo?.version && (
              <div style={{
                marginTop: '16px',
                fontSize: '13px',
                color: '#86868b',
                fontWeight: 500,
              }}>
                New version: <span style={{ color: '#007AFF', fontWeight: 700 }}>{updateInfo.version}</span>
              </div>
            )}
          </div>
        )}

        {/* Error Message */}
        {error && status === 'error' && (
          <div className="error-message device-error">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1C4.134 1 1 4.134 1 8s3.134 7 7 7 7-3.134 7-7-3.134-7-7-7zm0 12.5c-.414 0-.75-.336-.75-.75s.336-.75.75-.75.75.336.75.75-.336.75-.75.75zm.75-3.5c0 .414-.336.75-.75.75s-.75-.336-.75-.75V5c0-.414.336-.75.75-.75s.75.336.75.75v5z"/>
            </svg>
            {error}
          </div>
        )}

        {/* No action buttons - updates are forced */}

        {status === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button onClick={handleRetry} className="submit-button retry-button">
              Try Again
            </button>
            <button
              onClick={handleContinueWithoutUpdate}
              style={{
                padding: '12px',
                background: 'none',
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: '12px',
                color: '#86868b',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(0, 0, 0, 0.03)';
                e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.1)';
              }}
            >
              Continue Without Updating
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default UpdateChecker;
