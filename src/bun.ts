/**
 * LibreOffice WASM Document Converter - Bun Entry Point
 *
 * Provides Bun-compatible converter that works in both:
 * - Script mode: `bun examples/bun-conversion.ts`
 * - Compiled single-file mode: `bun build --compile` then `./binary`
 *
 * Architecture:
 * Due to a known Bun bug with Emscripten pthreads (the WASM module's LOK
 * initialization requires worker_threads pthreads, which crash in Bun),
 * this module uses a Node.js subprocess for the actual WASM execution.
 *
 * The Bun process acts as the orchestrator:
 * 1. Reads input files, manages output
 * 2. Forks a Node.js child process (execPath: "node") running the
 *    existing subprocess.worker.cjs
 * 3. Communicates via Node.js IPC (process.send/on message)
 *
 * Requirements: Node.js must be installed alongside Bun.
 *
 * @packageDocumentation
 */

import { fork, type ChildProcess, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import {
  ConversionError,
  ConversionErrorCode,
  FORMAT_MIME_TYPES,
  OUTPUT_FORMAT_TO_LOK,
  FORMAT_FILTER_OPTIONS,
} from './types.js';
import type {
  ConversionOptions,
  ConversionResult,
  LibreOfficeWasmOptions,
} from './types.js';

/**
 * Find the Node.js executable path.
 */
function findNodeExecutable(): string | null {
  try {
    const result = execSync('which node 2>/dev/null || where node 2>NUL', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim().split('\n')[0];
    if (result && existsSync(result.trim())) {
      return result.trim();
    }
  } catch {
    // Not found
  }
  const commonPaths = ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'];
  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface WorkerMessage {
  type: 'ready' | 'error' | 'response';
  id?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

interface BunSubprocessConverterOptions extends LibreOfficeWasmOptions {
  /** Max retries for initialization (default: 3) */
  maxInitRetries?: number;
  /** Max retries for conversion (default: 2) */
  maxConversionRetries?: number;
  /** Explicit path to Node.js executable (auto-detected if not provided) */
  nodePath?: string;
}

/**
 * Bun-compatible subprocess converter.
 *
 * Uses a Node.js subprocess to run the LibreOffice WASM module,
 * since Bun has a known incompatibility with Emscripten pthreads.
 *
 * The Bun process communicates with the Node.js child via IPC
 * (child_process.fork with execPath set to node).
 */
export class BunSubprocessConverter {
  private child: ChildProcess | null = null;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private options: BunSubprocessConverterOptions;
  private initialized = false;
  private initializing = false;
  private workerPath = '';
  private nodePath = '';
  private idCounter = 0;

  constructor(options: BunSubprocessConverterOptions = {}) {
    this.options = {
      wasmPath: './wasm',
      verbose: false,
      maxInitRetries: 3,
      maxConversionRetries: 2,
      ...options,
    };
  }

  private generateId(): string {
    return `bun_${++this.idCounter}_${Date.now()}`;
  }

  private resolveWorkerPath(): string {
    if (this.workerPath) return this.workerPath;

    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      if (currentDir.endsWith('/src') || currentDir.endsWith('\\src')) {
        this.workerPath = join(currentDir, '..', 'dist', 'subprocess.worker.cjs');
      } else {
        this.workerPath = join(currentDir, 'subprocess.worker.cjs');
      }
    } catch {
      this.workerPath = join(process.cwd(), 'dist', 'subprocess.worker.cjs');
    }

    if (!existsSync(this.workerPath)) {
      throw new ConversionError(
        ConversionErrorCode.WASM_NOT_INITIALIZED,
        `Subprocess worker not found at: ${this.workerPath}\nRun \`npm run build\` first.`
      );
    }

    return this.workerPath;
  }

  private async spawnWorker(): Promise<void> {
    const wasmPath = resolve(this.options.wasmPath || './wasm');
    const workerPath = this.resolveWorkerPath();

    if (!this.nodePath) {
      this.nodePath = this.options.nodePath || findNodeExecutable() || '';
      if (!this.nodePath) {
        throw new ConversionError(
          ConversionErrorCode.WASM_NOT_INITIALIZED,
          'Node.js executable not found. Node.js is required as a subprocess runtime\n' +
          'because Bun has a known incompatibility with Emscripten pthreads.\n' +
          'Install Node.js: https://nodejs.org/ or set the nodePath option.'
        );
      }
    }

    if (this.options.verbose) {
      console.error('[BunSubprocessConverter] Node.js:', this.nodePath);
      console.error('[BunSubprocessConverter] Worker:', workerPath);
    }

    this.child = fork(workerPath, [], {
      execPath: this.nodePath,
      env: { ...process.env, WASM_PATH: wasmPath, VERBOSE: String(this.options.verbose || false) },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.child.stdout?.on('data', (d: Buffer) => { if (this.options.verbose) process.stdout.write(d); });
    this.child.stderr?.on('data', (d: Buffer) => { if (this.options.verbose) process.stderr.write(d); });

    this.child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'response' && msg.id) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.success ? p.resolve(msg.data) : p.reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, msg.error || 'Error'));
        }
      }
    });

    this.child.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        for (const p of this.pending.values()) p.reject(new Error(`Subprocess exited with code ${code}`));
        this.pending.clear();
      }
      this.child = null;
      this.initialized = false;
    });

    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('Subprocess start timeout (30s)')), 30000);
      const h = (msg: WorkerMessage) => {
        if (msg.type === 'ready') { clearTimeout(t); this.child?.off('message', h); res(); }
        else if (msg.type === 'error') { clearTimeout(t); this.child?.off('message', h); rej(new Error(msg.error)); }
      };
      this.child?.on('message', h);
    });

    const hasFonts = this.options.fonts?.length;
    const hasSystemFonts = this.options.includeSystemFonts;
    const initPayload = (hasFonts || hasSystemFonts)
      ? {
        fonts: this.options.fonts?.map(f => ({
          filename: f.filename,
          data: Array.from(f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data),
        })),
        includeSystemFonts: this.options.includeSystemFonts,
      }
      : undefined;

    await this.send('init', initPayload, 180000);
  }

  private send(type: string, payload?: unknown, timeout = 300000): Promise<unknown> {
    return new Promise((res, rej) => {
      if (!this.child) { rej(new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'No subprocess')); return; }
      const id = this.generateId();
      this.pending.set(id, { resolve: res, reject: rej });
      this.child.send({ type, id, payload });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, `Timeout after ${timeout}ms`)); }
      }, timeout);
    });
  }

  private killWorker(): void {
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
      this.child = null;
    }
    this.initialized = false;
    this.pending.clear();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      while (this.initializing) await new Promise(r => setTimeout(r, 100));
      return;
    }
    this.initializing = true;

    const maxRetries = this.options.maxInitRetries || 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.killWorker();
        await this.spawnWorker();
        this.initialized = true;
        this.initializing = false;
        this.options.onReady?.();
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (this.options.verbose) {
          console.error(`[BunSubprocessConverter] Init attempt ${attempt}/${maxRetries} failed:`, lastError.message);
        }
        this.killWorker();
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }

    this.initializing = false;
    throw new ConversionError(
      ConversionErrorCode.WASM_NOT_INITIALIZED,
      `Init failed after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  private normalizeInput(input: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
    if (input instanceof Uint8Array) return input;
    return new Uint8Array(input);
  }

  async convert(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: ConversionOptions,
    filename = 'document'
  ): Promise<ConversionResult> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');

    const data = this.normalizeInput(input);
    if (data.length === 0) throw new ConversionError(ConversionErrorCode.INVALID_INPUT, 'Empty input');

    const ext = options.inputFormat ||
      (filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : 'docx');

    let filter = FORMAT_FILTER_OPTIONS[options.outputFormat] || '';
    if (options.outputFormat === 'pdf' && options.pdf) {
      const o: string[] = [];
      if (options.pdf.pdfaLevel) {
        const levelMap: Record<string, number> = { 'PDF/A-1b': 1, 'PDF/A-2b': 2, 'PDF/A-3b': 3 };
        o.push(`SelectPdfVersion=${levelMap[options.pdf.pdfaLevel] || 0}`);
      }
      if (options.pdf.quality !== undefined) o.push(`Quality=${options.pdf.quality}`);
      if (o.length) filter = o.join(',');
    }

    const maxRetries = this.options.maxConversionRetries || 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const start = Date.now();
        const r = await this.send('convert', {
          inputData: Array.from(data),
          inputExt: ext,
          outputFormat: OUTPUT_FORMAT_TO_LOK[options.outputFormat],
          filterOptions: filter,
        }) as number[];

        const base = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
        return {
          data: new Uint8Array(r),
          mimeType: FORMAT_MIME_TYPES[options.outputFormat],
          filename: `${base}.${options.outputFormat}`,
          duration: Date.now() - start,
        };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (this.options.verbose) console.error(`[BunSubprocessConverter] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 100));
      }
    }

    throw lastError || new ConversionError(ConversionErrorCode.CONVERSION_FAILED, 'Conversion failed');
  }

  async getPageCount(input: Uint8Array | ArrayBuffer | Buffer, inputFormat: string): Promise<number> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    const data = this.normalizeInput(input);
    return this.send('getPageCount', { inputData: Array.from(data), inputFormat }) as Promise<number>;
  }

  async destroy(): Promise<void> {
    if (this.child) {
      try { await this.send('destroy', undefined, 10000); } catch { /* may have exited */ }
      await new Promise(r => setTimeout(r, 100));
      if (this.child) {
        try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
        this.child = null;
      }
    }
    this.initialized = false;
    this.pending.clear();
  }

  isReady(): boolean { return this.initialized && this.child !== null; }
}

/**
 * Create and initialize a Bun subprocess converter.
 */
export async function createBunConverter(
  options: BunSubprocessConverterOptions = {}
): Promise<BunSubprocessConverter> {
  const converter = new BunSubprocessConverter(options);
  await converter.initialize();
  return converter;
}

export type { ConversionOptions, ConversionResult, LibreOfficeWasmOptions } from './types.js';
export { ConversionError, ConversionErrorCode, FORMAT_MIME_TYPES } from './types.js';
