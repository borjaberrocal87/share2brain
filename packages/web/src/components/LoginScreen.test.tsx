// Component tests for the login screen's guest + demo-invite affordances (Story
// 2.5 + 2.6). Mocks api/auth (mirror SearchView.test.tsx's vi.mock pattern) — no
// network, no jest-dom matchers (toBeTruthy()/toBeNull(), per testing rules).
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as authApi from '../api/auth';
// Importing i18n initializes the global instance (default 'es') the component's
// useTranslation reads — same approach as SearchView.test.tsx.
import '../i18n';
import { LoginScreen } from './LoginScreen';

vi.mock('../api/auth', () => ({
  fetchGuestAvailability: vi.fn(),
  LOGIN_URL: '/api/auth/login',
}));

const fetchGuestAvailability = vi.mocked(authApi.fetchGuestAvailability);

const noop = (): void => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginScreen — demo invite row (Story 2.6)', () => {
  it('should render the invite link with href/target/rel + i18n copy when enabled with an inviteUrl', async () => {
    fetchGuestAvailability.mockResolvedValue({ enabled: true, inviteUrl: 'https://discord.gg/x' });
    render(<LoginScreen onLogin={noop} onGuest={noop} />);

    const link = await screen.findByTestId('demo-invite-link');
    expect(link.getAttribute('href')).toBe('https://discord.gg/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(link.textContent).toBe('Únete al servidor Discord de demo');
    expect(screen.getByText('¿No tienes acceso?')).toBeTruthy();
  });

  it('should render the guest button but NOT the invite link when enabled without an inviteUrl', async () => {
    fetchGuestAvailability.mockResolvedValue({ enabled: true });
    render(<LoginScreen onLogin={noop} onGuest={noop} />);

    expect(await screen.findByTestId('guest-login-btn')).toBeTruthy();
    expect(screen.queryByTestId('demo-invite-link')).toBeNull();
  });

  it('should render neither the guest button nor the invite link when disabled', async () => {
    fetchGuestAvailability.mockResolvedValue({ enabled: false });
    render(<LoginScreen onLogin={noop} onGuest={noop} />);

    // Let the probe promise + state update flush before asserting absence.
    await waitFor(() => expect(fetchGuestAvailability).toHaveBeenCalled());
    expect(screen.queryByTestId('guest-login-btn')).toBeNull();
    expect(screen.queryByTestId('demo-invite-link')).toBeNull();
  });
});
