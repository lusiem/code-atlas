import { createRequire } from 'node:module';

/** Package version, read from package.json (works from src/ and dist/ alike). */
export const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
