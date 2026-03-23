/**
 * Bun-compatible entry point for @matbee/libreoffice-converter
 *
 * Import path: `@matbee/libreoffice-converter/bun`
 *
 * Re-exports the full Node.js-compatible converter API and adds two small
 * helpers that power the **self-spawning subprocess** pattern required for
 * Bun compiled standalone executables:
 *
 *   • `isBunSubprocess()`     – call at the top of your entry point
 *   • `isBunCompiledBinary()` – optional, for output-path or arg-parsing logic
 *
 * @example
 * ```typescript
 * // my-app.ts  (works as  `bun my-app.ts`  AND  `./my-app`)
 * import { isBunSubprocess, isBunCompiledBinary } from '@matbee/libreoffice-converter/bun';
 * import { createRequire } from 'module';
 * import { resolve, join } from 'path';
 *
 * // ── self-spawning: handle WASM worker role ─────────────────────────────
 * if (isBunSubprocess()) {
 *   // Load WASM and handle conversion via stdin/stdout IPC.
 *   // See examples/bun-conversion.ts for a complete implementation.
 *   await runSubprocessMode();
 *   process.exit(0);
 * }
 *
 * // ── main process logic ─────────────────────────────────────────────────
 * const compiled = isBunCompiledBinary();
 * // ...
 * ```
 *
 * @see {@link https://bun.sh/docs/bundler/executables} Bun standalone executables
 * @see {@link ../docs/BUN.md} for a full technical explanation
 *
 * @packageDocumentation
 */

// Re-export the entire public API so callers can use a single import path.
export * from './index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bun runtime helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `true` when the current process was spawned as a WASM subprocess
 * worker by the main process.
 *
 * The main process sets the `BUN_SUBPROCESS_WORKER=1` environment variable
 * before spawning the child, and the child checks it at startup.
 *
 * @example
 * ```typescript
 * if (isBunSubprocess()) {
 *   await runSubprocessMode();
 *   process.exit(0);
 * }
 * ```
 */
export function isBunSubprocess(): boolean {
  return process.env.BUN_SUBPROCESS_WORKER === '1';
}

/**
 * Returns `true` when the script is running as a **Bun compiled standalone
 * binary** (built with `bun build --compile`).
 *
 * Detection strategy (most specific first):
 * 1. `process.argv[1]` starts with `/$bunfs/` – the canonical indicator for
 *    compiled Bun binaries (Bun mounts the bundle under its virtual FS).
 * 2. `process.argv[1]` does not match a script-file extension (`.ts`, `.js`,
 *    `.mjs`, etc.) – fallback for future Bun releases.
 *
 * Use this to determine the correct output directory or resolve deployment
 * paths.
 *
 * @example
 * ```typescript
 * const compiled = isBunCompiledBinary();
 * const outputDir = compiled ? './converted-single' : './converted';
 * ```
 */
export function isBunCompiledBinary(): boolean {
  const a1 = process.argv[1];
  if (!a1) return true;
  if (a1.startsWith('/$bunfs/')) return true;
  return !a1.match(/\.[mc]?[jt]sx?$/);
}
