import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, SHARED_KERNEL_VERSION } from './index.js';

describe('shared kernel', () => {
  it('should expose the package name when imported', () => {
    expect(PACKAGE_NAME).toBe('@hivly/shared');
  });

  it('should expose a semver-shaped kernel version', () => {
    expect(SHARED_KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/);
  });
});
