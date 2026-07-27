import React from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * The Kairos brand mark: a grey ring, a half-arc in the accent colour rotated
 * -18deg, and a centre dot.
 *
 * The same geometry is baked into the app icon — scripts/generate-brand-icons.mjs
 * renders src/images/kairos_logo.{png,ico} from it. Change one, re-run the other.
 *
 * Colours default to the landing page's scene variables when they're in scope
 * (`--accent` / `--line`) and fall back to the MUI theme everywhere else, so the
 * mark drops into any screen without wiring.
 */
export interface KairosMarkProps {
  /** Edge length in px. All strokes scale from this. */
  size?: number;
  /** Arc + centre dot colour. */
  accent?: string;
  /** Ring colour. */
  ring?: string;
  sx?: SxProps<Theme>;
}

const KairosMark: React.FC<KairosMarkProps> = ({
  size = 60,
  accent,
  ring,
  sx,
}) => {
  // Proportions taken from the original 60px mark: 1.5px stroke, 12px dot.
  const stroke = (size * 1.5) / 60;
  const dot = (size * 12) / 60;

  const accentColor = accent ?? 'var(--accent)';
  const ringColor = ring ?? 'var(--line)';

  return (
    <Box
      aria-hidden
      sx={[
        { position: 'relative', width: size, height: size, flexShrink: 0 },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {/* Full ring */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `${stroke}px solid ${ringColor}`,
        }}
      />
      {/* Accent half — top + right borders, rotated so the split reads off-axis */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          border: `${stroke}px solid transparent`,
          borderTopColor: accentColor,
          borderRightColor: accentColor,
          transform: 'rotate(-18deg)',
        }}
      />
      {/* Centre dot */}
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: dot,
          height: dot,
          mt: `${-dot / 2}px`,
          ml: `${-dot / 2}px`,
          borderRadius: '50%',
          background: accentColor,
        }}
      />
    </Box>
  );
};

export default KairosMark;
