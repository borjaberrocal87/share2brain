// Share2Brain brand hexagon (Story 2.1): a presentational, dependency-free primitive
// reused across Epics 2 and 5 (login mark, sidebar logo, chat header, agent
// avatar). Structure = three nested hexagons sharing one clip-path polygon:
//   outer  amber gradient  ->  middle  bg-color fill  ->  inner  amber dot.
// `size` (outer px) drives the nested dimensions; exact values for the sizes
// this epic needs come from the design prototype, others interpolate.
import type { CSSProperties, ReactElement, ReactNode } from 'react';

// Exported so the chat FAB (Story 5.3) can reuse the exact brand hexagon shape +
// fill without re-inlining the magic polygon string. The FAB is a SINGLE amber
// hexagon (not the 3-layer Hexagon component), so it applies these consts inline.
export const CLIP_PATH = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
export const AMBER_GRADIENT = 'linear-gradient(150deg, #FFCB6B, #F5A623)';
const AMBER = '#F5A623';

// Exact inner dimensions per outer size, from Share2Brain Web.dc.html. Sizes not
// listed fall back to the proportional rule (middle ~0.55x, dot ~0.19x).
const EXACT_MIDDLE: Record<number, number> = { 74: 42, 32: 18, 30: 15 };
const EXACT_DOT: Record<number, number> = { 74: 14, 32: 6 };

interface HexagonProps {
  /** Outer hexagon size in px; drives the nested dimensions. */
  size: number;
  /** Middle hexagon fill: the page background (default) or the deeper background. */
  innerBg?: 'bg' | 'bg-deep';
  /** Render the amber center dot (default true). */
  showDot?: boolean;
  /** Optional content centered inside the middle hexagon (e.g. a login icon). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const hexLayer = (px: number, background: string): CSSProperties => ({
  width: px,
  height: px,
  background,
  clipPath: CLIP_PATH,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export function Hexagon({
  size,
  innerBg = 'bg',
  showDot = true,
  children,
  className,
  style,
}: HexagonProps): ReactElement {
  const clampedSize = Math.max(1, Math.round(size));
  if (import.meta.env.DEV && (size !== clampedSize || !Number.isFinite(size))) {
    console.warn(`Hexagon: invalid size "${String(size)}" — clamped to ${clampedSize}`);
  }
  const middle = EXACT_MIDDLE[clampedSize] ?? Math.round(clampedSize * 0.55);
  const dot = EXACT_DOT[clampedSize] ?? Math.round(clampedSize * 0.19);
  if (import.meta.env.DEV && innerBg !== 'bg' && innerBg !== 'bg-deep') {
    console.warn(`Hexagon: unexpected innerBg "${String(innerBg)}" — falling back to var(--bg)`);
  }
  const middleFill = innerBg === 'bg-deep' ? 'var(--bg-deep)' : 'var(--bg)';

  return (
    <div className={className} style={{ ...hexLayer(clampedSize, AMBER_GRADIENT), ...style }}>
      <div style={{ ...hexLayer(middle, middleFill), position: 'relative' }}>
        {showDot && !children && <div style={hexLayer(dot, AMBER)} />}
        {children}
      </div>
    </div>
  );
}
