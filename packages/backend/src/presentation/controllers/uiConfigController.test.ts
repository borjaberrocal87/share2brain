// Unit tests for the Epic 10 UI config controller. No DB/Redis: minimal res
// double (per authController.guest.test.ts's fakeRes()) — the handler never
// touches req.session (D6), so req can stay an empty object.
import { UiConfigResponseSchema } from '@share2brain/shared/schemas';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createUiConfigController } from './uiConfigController.js';

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
}

describe('createUiConfigController', () => {
  it('should respond 200 with { language: "es" } when configured to "es"', () => {
    const controller = createUiConfigController({ language: 'es' });
    const res = fakeRes();

    controller.get({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ language: 'es' });
    expect(UiConfigResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('should respond 200 with { language: "en" } when configured to "en"', () => {
    const controller = createUiConfigController({ language: 'en' });
    const res = fakeRes();

    controller.get({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ language: 'en' });
    expect(UiConfigResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
