// Full-screen login (Story 2.2, AC1 + AC7). Presentational: it renders the
// gradient background, four decorative floating hexagons, and the auth card.
// The button calls `onLogin` (full-page navigation to Discord OAuth2).
// UI copy is Spanish verbatim from the prototype; identifiers/comments English
// (see story Dev Notes -> Language rule).
import type { CSSProperties, ReactElement } from 'react';

import { DiscordIcon, LockIcon } from './icons';
import { Hexagon } from './Hexagon';

interface LoginScreenProps {
  /** Start the Discord login (full-page navigation). */
  onLogin: () => void;
}

// The four decorative hexagons are flat-tint clip-path shapes (NOT the brand
// Hexagon component) drifting with kh-float. Values from the prototype.
const CLIP_HEX = 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)';
const DECOR_HEXAGONS: CSSProperties[] = [
  { width: 180, height: 180, left: '8%', top: '18%', background: 'rgba(245,166,35,0.05)', animation: 'kh-float 9s ease-in-out infinite' },
  { width: 120, height: 120, left: '80%', top: '24%', background: 'rgba(88,101,242,0.06)', animation: 'kh-float 11s ease-in-out infinite 1.5s' },
  { width: 90, height: 90, left: '18%', top: '70%', background: 'rgba(245,166,35,0.05)', animation: 'kh-float 10s ease-in-out infinite 0.7s' },
  { width: 140, height: 140, left: '72%', top: '66%', background: 'rgba(245,166,35,0.04)', animation: 'kh-float 13s ease-in-out infinite 2.2s' },
];

const screenStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  color: 'var(--text-primary)',
  background:
    'radial-gradient(1200px 700px at 50% -10%, rgba(245,166,35,0.10), transparent 60%), radial-gradient(900px 600px at 85% 110%, rgba(88,101,242,0.10), transparent 55%), var(--bg-deep)',
};

const cardStyle: CSSProperties = {
  position: 'relative',
  width: 430,
  maxWidth: '92vw',
  padding: '48px 44px 36px',
  background: 'var(--card)',
  border: '1px solid var(--border-strong)',
  borderRadius: 20,
  boxShadow: '0 40px 90px -30px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.03)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
};

export function LoginScreen({ onLogin }: LoginScreenProps): ReactElement {
  return (
    <div style={screenStyle}>
      {DECOR_HEXAGONS.map((hex, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{ position: 'absolute', clipPath: CLIP_HEX, ...hex }}
        />
      ))}

      <div style={cardStyle}>
        <Hexagon size={74} style={{ boxShadow: '0 12px 30px -8px rgba(245,166,35,0.6)' }} />

        <h1
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: '22px 0 0',
          }}
        >
          Share2Brain
        </h1>

        <div
          style={{
            marginTop: 6,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11.5,
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
          }}
        >
          Agente de conocimiento · self-hosted
        </div>

        <p
          style={{
            margin: '20px 2px 0',
            fontSize: 14.5,
            lineHeight: 1.55,
            color: 'var(--text-secondary)',
          }}
        >
          El conocimiento de tu comunidad de Discord, indexado y consultable. Iniciá sesión para
          buscar y chatear con el agente.
        </p>

        <button
          type="button"
          className="kh-discord-btn"
          onClick={onLogin}
          style={{
            marginTop: 28,
            width: '100%',
            height: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 11,
            border: 'none',
            borderRadius: 12,
            cursor: 'pointer',
            fontSize: 15,
            fontWeight: 600,
            color: '#fff',
            background: '#5865F2',
            boxShadow: '0 10px 24px -10px rgba(88,101,242,0.8)',
          }}
        >
          <DiscordIcon size={22} />
          Continuar con Discord
        </button>

        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 12.5,
          }}
        >
          <LockIcon size={13} />
          Solo miembros del guild pueden acceder
        </div>

        <div
          style={{
            marginTop: 26,
            paddingTop: 18,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            width: '100%',
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 10.5,
            color: 'var(--text-subtle)',
            letterSpacing: '0.04em',
          }}
        >
          <span>scope: identify · guilds.members.read</span>
          <span>v4.0</span>
        </div>
      </div>
    </div>
  );
}
