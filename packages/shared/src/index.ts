// @share2brain/shared — the domain kernel. Every service depends on this package and,
// per AD-2, on no other @share2brain/* package. This root barrel re-exports the public
// contract surface; subpath entrypoints (`@share2brain/shared/db`, `/schemas`,
// `/config`, `/types/events`) are also declared in package.json `exports`.
export const PACKAGE_NAME = '@share2brain/shared';
export const SHARED_KERNEL_VERSION = '0.0.0';

export * from './config/index.js';
export * from './schemas/index.js';
export * from './db/index.js';
export * from './types/events.js';
