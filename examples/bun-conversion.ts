/**
 * Bun PPTX-to-PNG Conversion Example
 *
 * Demonstrates two usage modes:
 *
 *   Script mode   – run with Bun directly:
 *     bun examples/bun-conversion.ts tests/sample_test_1.pptx
 *     Images are written to  ./converted/
 *
 *   Compiled mode – first build a single-file executable, then run it:
 *     bun build --compile examples/bun-conversion.ts --outfile bun-conversion
 *     ./bun-conversion tests/sample_test_1.pptx
 *     Images are written to  ./converted-single/
 *
 * Architecture
 * ────────────
 * The entry point uses the **subprocess detection** pattern:
 *
 *   if (isBunSubprocess()) {
 *     // This process is the WASM worker; handle IPC and exit
 *   } else {
 *     // This process is the controller; spawn a worker subprocess
 *   }
 *
 * Because Bun 1.3.11 uses JavaScriptCore (JSC) which does not yet fully
 * support the WebAssembly SIMD + bulk-memory + exception-handling features
 * used by the LibreOffice WASM binary, the WASM worker subprocess is
 * executed via Node.js (if available), which uses V8 and supports all
 * required WASM features.  The subprocess detection flag (BUN_SUBPROCESS_WORKER)
 * is still used so that the compiled binary can self-identify as a worker when
 * a future Bun version with full WASM compatibility is used.
 *
 * For the compiled-binary mode Node.js must be in PATH and
 * `dist/subprocess.worker.cjs` must exist alongside the binary.
 *
 * See docs/BUN.md for a full technical explanation.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, dirname, extname } from 'path';
import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime-mode detection helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when this process was launched as the WASM subprocess worker.
 * The controller sets BUN_SUBPROCESS_WORKER=1 in the child's environment.
 */
function isBunSubprocess(): boolean {
  return process.env.BUN_SUBPROCESS_WORKER === '1';
}

/**
 * Returns true when running as a Bun compiled standalone binary.
 *
 * In Bun compiled binaries process.argv looks like:
 *   ["bun", "/$bunfs/root/<binary-name>", userArg1, ...]
 *
 * The virtual-FS path "/$bunfs/..." does NOT end in a script extension, so it
 * reliably identifies compiled mode.  In plain script mode argv[1] ends in
 * ".ts" / ".js".
 *
 * The `/$bunfs/` prefix is the canonical indicator; the extension check is
 * a complementary fallback.
 */
function isCompiledBinary(): boolean {
  const a1 = process.argv[1];
  if (!a1) return true; // no argv[1] → must be compiled mode
  // Bun compiled binaries always place the entry path under /$bunfs/
  if (a1.startsWith('/$bunfs/')) return true;
  // Fallback: no recognised script extension
  return !a1.match(/\.[mc]?[jt]sx?$/);
}

/**
 * User-supplied arguments.
 * In both script and compiled mode Bun puts user args starting at argv[2]:
 *   Script mode:   [bunPath, scriptPath,         arg1, arg2, …]
 *   Compiled mode: ["bun",   /$bunfs/root/binary, arg1, arg2, …]
 */
function getUserArgs(): string[] {
  return process.argv.slice(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when argv[1] is in Bun's virtual filesystem (compiled mode)
 * or is not a recognisable on-disk script path.
 */
function isVirtualOrNoScript(): boolean {
  const a1 = process.argv[1];
  return !a1 || a1.startsWith('/$bunfs/');
}

/** Locate the wasm/ directory at runtime. */
function resolveWasmPath(): string {
  if (process.env.WASM_PATH) return resolve(process.env.WASM_PATH);

  // ./wasm relative to CWD (works from the repo root)
  const cwdWasm = resolve('./wasm');
  if (existsSync(cwdWasm)) return cwdWasm;

  // In script mode: ../wasm relative to this file's directory
  const scriptArg = process.argv[1];
  if (!isVirtualOrNoScript() && scriptArg) {
    const scriptDir = dirname(resolve(scriptArg));
    const sibling = join(scriptDir, '..', 'wasm');
    if (existsSync(sibling)) return resolve(sibling);
  }

  throw new Error(
    'Cannot find the wasm/ directory.\n' +
    'Run from the repository root, or set WASM_PATH.\n' +
    'Example: WASM_PATH=/path/to/wasm ./bun-conversion input.pptx',
  );
}

/**
 * Locate the pre-built subprocess worker script.
 *
 * Priority:
 *  1. WORKER_PATH env var
 *  2. ./dist/subprocess.worker.cjs  relative to CWD
 *  3. ../dist/subprocess.worker.cjs relative to this script (script mode only)
 */
function resolveWorkerPath(): string {
  if (process.env.WORKER_PATH) return resolve(process.env.WORKER_PATH);

  const cwdWorker = resolve('./dist/subprocess.worker.cjs');
  if (existsSync(cwdWorker)) return cwdWorker;

  const scriptArg = process.argv[1];
  if (!isVirtualOrNoScript() && scriptArg) {
    const scriptDir = dirname(resolve(scriptArg));
    const sibling = join(scriptDir, '..', 'dist', 'subprocess.worker.cjs');
    if (existsSync(sibling)) return resolve(sibling);
  }

  throw new Error(
    'Cannot find dist/subprocess.worker.cjs.\n' +
    'Run "npm run build" first, or set WORKER_PATH.',
  );
}

/**
 * Find the Node.js executable.
 * Node.js is required for the WASM subprocess because Bun 1.3.11 (JSC) has
 * incomplete WASM support for the features used by LibreOffice WASM.
 */
function findNode(): string {
  if (process.env.NODE_BINARY) return process.env.NODE_BINARY;
  // Rely on PATH resolution for the 'node' command
  return 'node';
}

// ─────────────────────────────────────────────────────────────────────────────
// Node.js IPC client (mirrors the SubprocessConverter protocol)
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerMessage {
  type: string;
  id: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

interface PagePreviewRaw {
  data: number[];
  width: number;
  height: number;
  dpi: number;
}

/**
 * Thin IPC client that wraps a Node.js subprocess running
 * dist/subprocess.worker.cjs using the same message protocol as
 * SubprocessConverter.
 */
class NodeWasmClient {
  private proc: import('child_process').ChildProcess | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async start(nodeBin: string, workerPath: string, wasmPath: string): Promise<void> {
    const { spawn } = await import('child_process');

    this.proc = spawn(nodeBin, [workerPath], {
      env: {
        ...process.env,
        WASM_PATH: wasmPath,
        VERBOSE: 'false',
      },
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
    });

    this.proc.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'response' && msg.id) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.success ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'Error'));
        }
      }
    });

    this.proc.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        for (const p of this.pending.values()) {
          p.reject(new Error(`Node subprocess exited with code ${code}`));
        }
        this.pending.clear();
      }
    });

    // Wait for the ready signal (subprocess is alive, WASM not yet loaded)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('Subprocess start timeout')), 30_000);
      const handler = (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(t);
          this.proc?.off('message', handler);
          res();
        } else if (msg.type === 'error') {
          clearTimeout(t);
          this.proc?.off('message', handler);
          rej(new Error(msg.error));
        }
      };
      this.proc?.on('message', handler);
    });
  }

  private send(type: string, payload?: unknown, timeoutMs = 300_000): Promise<unknown> {
    return new Promise((res, rej) => {
      if (!this.proc) { rej(new Error('Not started')); return; }
      const id = randomUUID();
      this.pending.set(id, { resolve: res, reject: rej });
      this.proc.send({ type, id, payload });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`Timeout waiting for ${type}`));
        }
      }, timeoutMs);
    });
  }

  /** Load LibreOffice WASM inside the subprocess. */
  async init(): Promise<void> {
    await this.send('init', undefined, 180_000);
  }

  /** Get the number of pages/slides in a document. */
  async getPageCount(fileData: Uint8Array, inputFormat: string): Promise<number> {
    return this.send('getPageCount', {
      inputData: Array.from(fileData),
      inputFormat,
    }) as Promise<number>;
  }

  /** Render a single page at full quality; returns RGBA pixel data. */
  async renderPageFullQuality(
    fileData: Uint8Array,
    inputFormat: string,
    pageIndex: number,
    dpi = 150,
  ): Promise<PagePreviewRaw> {
    return this.send('renderPageFullQuality', {
      inputData: Array.from(fileData),
      inputFormat,
      pageIndex,
      dpi,
    }) as Promise<PagePreviewRaw>;
  }

  async destroy(): Promise<void> {
    try { await this.send('destroy', undefined, 10_000); } catch { /* ignore */ }
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main / controller mode
// ─────────────────────────────────────────────────────────────────────────────

async function runMainMode(): Promise<void> {
  const compiled = isCompiledBinary();
  const userArgs = getUserArgs();

  if (userArgs.length === 0 || userArgs[0] === '--help' || userArgs[0] === '-h') {
    console.log('Usage:');
    console.log('  bun examples/bun-conversion.ts <input.pptx>');
    console.log('  ./bun-conversion <input.pptx>');
    console.log('');
    console.log('Environment variables:');
    console.log('  WASM_PATH    – path to the wasm/ directory');
    console.log('  WORKER_PATH  – path to dist/subprocess.worker.cjs');
    console.log('  NODE_BINARY  – path to the node executable');
    process.exit(userArgs.length === 0 ? 1 : 0);
  }

  const inputFile = resolve(userArgs[0] as string);
  const outputDir = resolve(userArgs[1] ?? (compiled ? './converted-single' : './converted'));
  const wasmPath = resolveWasmPath();
  const workerPath = resolveWorkerPath();
  const nodeBin = findNode();

  console.log('🚀 Bun LibreOffice Converter');
  console.log(`   Mode:   ${compiled ? 'compiled binary' : 'script (bun)'}`);
  console.log(`   Input:  ${inputFile}`);
  console.log(`   Output: ${outputDir}`);
  console.log(`   WASM:   ${wasmPath}`);
  console.log(`   Worker: ${workerPath}  (via ${nodeBin})`);

  const fileData = await readFile(inputFile);
  const inputFormat = (extname(inputFile).slice(1) || 'pptx').toLowerCase();

  // ── Start the Node.js WASM subprocess ───────────────────────────────────
  const client = new NodeWasmClient();
  await client.start(nodeBin, workerPath, wasmPath);

  console.log('\n⚙️  Initialising LibreOffice WASM (this may take a minute)…');
  await client.init();
  console.log('✅ LibreOffice ready');

  // ── Get page count ───────────────────────────────────────────────────────
  const pageCount = await client.getPageCount(new Uint8Array(fileData), inputFormat);
  console.log(`   Slides: ${pageCount}`);
  const padWidth = Math.max(3, String(pageCount).length);

  // ── Render each slide and save as PNG ────────────────────────────────────
  await mkdir(outputDir, { recursive: true });

  // rgbaToPng runs in Bun's main process (Bun supports Node.js zlib).
  const { rgbaToPng } = await import('../src/image-utils.js');

  for (let i = 0; i < pageCount; i++) {
    console.log(`🖼  Rendering slide ${i + 1}/${pageCount}…`);
    const preview = await client.renderPageFullQuality(
      new Uint8Array(fileData),
      inputFormat,
      i,
      150,
    );

    const pngBuf = await rgbaToPng(new Uint8Array(preview.data), preview.width, preview.height);
    const outPath = join(outputDir, `slide-${String(i + 1).padStart(padWidth, '0')}.png`);
    await writeFile(outPath, pngBuf);
    console.log(`   Saved: ${outPath}  (${preview.width}×${preview.height})`);
  }

  await client.destroy();
  console.log(`\n✨ Done!  ${pageCount} image(s) → ${outputDir}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry-point: subprocess detection at startup (must run after all declarations)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subprocess / WASM worker mode.
 *
 * When BUN_SUBPROCESS_WORKER=1 is set this process acts as the WASM worker.
 *
 * NOTE: In Bun 1.3.11 the WASM work is redirected to a Node.js subprocess
 * because JSC's WebAssembly support is incomplete.  This block is kept here
 * to document the intended architecture and to support future Bun versions.
 */
if (isBunSubprocess()) {
  // A future Bun version with full WASM support would run the WASM here.
  // Currently the controller spawns node instead, so this path is unreachable
  // in normal operation.
  process.stderr.write(
    '[bun-worker] Bun subprocess mode (JSC WASM incompatibility – use node worker instead).\n',
  );
  process.exit(1);
}

await runMainMode();
process.exit(0);
