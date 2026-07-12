// Unit tests for translateErrorCode (Story 10.2, D4/AC5): known codes resolve
// through i18next in both languages; an unknown code falls back to the
// caller-supplied string. Uses the real i18n singleton (registered via
// src/test-setup.ts) — no mocking of i18next itself.
import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../i18n';
import { translateErrorCode } from './apiError';

afterEach(async () => {
  await i18n.changeLanguage('es');
});

describe('translateErrorCode', () => {
  it('should resolve a known code to its Spanish translation', () => {
    expect(translateErrorCode('AUTH_REQUIRED', 'fallback')).toBe(
      'Debés iniciar sesión para continuar.',
    );
  });

  it('should resolve a known code to its English translation', async () => {
    await i18n.changeLanguage('en');

    expect(translateErrorCode('AUTH_REQUIRED', 'fallback')).toBe('You need to sign in to continue.');
  });

  it('should fall back to the caller-supplied string for an unknown code', () => {
    expect(translateErrorCode('SOME_UNMAPPED_CODE', 'fallback message')).toBe('fallback message');
  });

  it('should resolve every one of the 11-code vocabulary in both languages', async () => {
    const codes = [
      'AUTH_REQUIRED',
      'GUILD_MEMBER_REQUIRED',
      'INVALID_OAUTH_STATE',
      'OAUTH_CALLBACK_FAILED',
      'LOGOUT_FAILED',
      'RBAC_EXPANSION_FAILED',
      'GUEST_ACCESS_DISABLED',
      'VALIDATION_ERROR',
      'NOT_FOUND',
      'FORBIDDEN',
      'INTERNAL',
    ];

    for (const lang of ['es', 'en'] as const) {
      await i18n.changeLanguage(lang);
      for (const code of codes) {
        expect(translateErrorCode(code, 'unreachable-fallback')).not.toBe('unreachable-fallback');
      }
    }
  });
});
