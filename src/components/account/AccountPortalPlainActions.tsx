import React from 'react';
import { useAccountPortal } from './useAccountPortal';

interface Props {
  /** Primary button label. */
  label?: string;
  /** Matches the surrounding card's theme (auth screens thread this manually). */
  isDark: boolean;
}

/**
 * Plain-CSS twin of `AccountPortalActions`, for the pre-app auth screens that
 * use the `auth-card` look (`src/styles/auth.css`) rather than MUI. Same
 * behaviour, same hook — only the presentation differs, so those cards keep
 * their own idiom instead of sprouting a lone MUI button.
 */
const AccountPortalPlainActions: React.FC<Props> = ({
  label = 'Open Atlas portal',
  isDark,
}) => {
  const { url, open, copy, copied, failed } = useAccountPortal();

  const secondaryStyle: React.CSSProperties = {
    padding: '10px 16px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'var(--primary-blue)',
    background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    border: '1px solid var(--primary-blue)',
    borderRadius: '10px',
    cursor: 'pointer',
    width: '100%',
  };

  return (
    <div style={{ marginTop: '16px' }}>
      <button
        onClick={() => void open()}
        className="submit-button"
        style={{ width: '100%' }}
      >
        {label}
      </button>

      <button onClick={() => void copy()} style={{ ...secondaryStyle, marginTop: '8px' }}>
        {copied ? 'Link copied' : 'Copy link'}
      </button>

      {failed && (
        <p style={{ fontSize: '13px', color: '#FF9500', marginTop: '8px' }}>
          Could not open your browser. Copy the link below and paste it in manually.
        </p>
      )}

      <p
        style={{
          marginTop: '10px',
          padding: '8px',
          borderRadius: '8px',
          background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          fontFamily: 'monospace',
          fontSize: '12px',
          wordBreak: 'break-all',
          userSelect: 'text',
        }}
      >
        {url}
      </p>

      <p style={{ fontSize: '12px', opacity: 0.7, marginTop: '8px' }}>
        This opens in your default web browser.
      </p>
    </div>
  );
};

export default AccountPortalPlainActions;
