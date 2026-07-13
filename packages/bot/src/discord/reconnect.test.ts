// Unit test for the reconnect backoff (AC-4): computeDelay's sequence/cap/jitter
// bounds, and connectWithRetry's retry-until-success, error escalation, and reset.
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';
import { computeDelay, connectWithRetry } from './reconnect.js';

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('computeDelay', () => {
  it('should follow the 1s → 2s → 4s exponential schedule within ±10% jitter', () => {
    const bases = [1_000, 2_000, 4_000, 8_000];
    bases.forEach((base, i) => {
      const attempt = i + 1;
      const delay = computeDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
      expect(delay).toBeLessThanOrEqual(Math.ceil(base * 1.1));
    });
  });

  it('should cap the base delay at 300s (5 min) for large attempts', () => {
    const delay = computeDelay(20); // 1000 * 2^19 far exceeds the cap
    expect(delay).toBeGreaterThanOrEqual(Math.floor(300_000 * 0.9));
    expect(delay).toBeLessThanOrEqual(Math.ceil(300_000 * 1.1));
  });
});

describe('connectWithRetry', () => {
  it('should retry until login succeeds, sleeping between attempts', async () => {
    let calls = 0;
    const login = vi.fn(() => {
      calls += 1;
      return calls <= 2 ? Promise.reject(new Error('invalid session')) : Promise.resolve('token');
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    await connectWithRetry({ login, logger, sleep });

    expect(login).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // First two delays are the ~1s and ~2s steps (jitter-bounded).
    const [d1] = sleep.mock.calls[0] as [number];
    const [d2] = sleep.mock.calls[1] as [number];
    expect(d1).toBeGreaterThanOrEqual(900);
    expect(d1).toBeLessThanOrEqual(1_100);
    expect(d2).toBeGreaterThanOrEqual(1_800);
    expect(d2).toBeLessThanOrEqual(2_200);
  });

  it('should reset the backoff to ~1s on a fresh invocation after a prior success', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    // First run: succeeds immediately (no sleep).
    await connectWithRetry({ login: vi.fn().mockResolvedValue('t'), logger, sleep });
    expect(sleep).not.toHaveBeenCalled();

    // Second run (simulating a later reconnect): fail once then succeed. The first
    // delay must be the ~1s step again — proving attempt counting reset.
    let calls = 0;
    const login = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('drop')) : Promise.resolve('t');
    });
    await connectWithRetry({ login, logger, sleep });

    const [firstDelay] = sleep.mock.calls[0] as [number];
    expect(firstDelay).toBeGreaterThanOrEqual(900);
    expect(firstDelay).toBeLessThanOrEqual(1_100);
  });

  it('should escalate to error-level logging after 5 consecutive failures', async () => {
    let calls = 0;
    const login = vi.fn(() => {
      calls += 1;
      return calls <= 5 ? Promise.reject(new Error('outage')) : Promise.resolve('t');
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    await connectWithRetry({ login, logger, sleep });

    // Attempts 1–4 warn; attempt 5 escalates to error.
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('still retrying'),
      expect.objectContaining({ attempt: 5 }),
    );
  });
});
