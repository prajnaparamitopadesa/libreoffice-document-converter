/**
 * Bun Subprocess LibreOffice Converter
 *
 * Since Bun's JSC engine has a compatibility issue with the Emscripten-generated
 * LibreOffice WASM module (segfault in _libreofficekit_hook), WASM processing
 * is delegated to a Node.js subprocess. This is architecturally correct:
 *
 * - Main process: Bun (user code, fast startup, TypeScript native)
 * - Subprocess: Node.js (WASM processing, proven Emscripten compatibility)
 * - Communication: IPC via child_process.fork()
 *
 * Uses the same subprocess.worker.cjs and IPC protocol as the existing
 * SubprocessConverter, ensuring full feature parity.
 */

import { fork, type ChildProcess } from 'child_process';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import {
  ConversionError,
  ConversionErrorCode,
  type ConversionOptions,
  type ConversionResult,
  FORMAT_MIME_TYPES,
  OUTPUT_FORMAT_TO_LOK,
  FORMAT_FILTER_OPTIONS,
  type InputFormatOptions,
  type LibreOfficeWasmOptions,
} from './types.js';

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
  /** Whether to restart subprocess on memory errors (default: true) */
  restartOnMemoryError?: boolean;
  /** Path to the Node.js executable (auto-detected if not provided) */
  nodePath?: string;
}

/**
 * Find the Node.js executable path.
 */
function findNodeExecutable(providedPath?: string): string {
  if (providedPath) {
    if (fs.existsSync(providedPath)) return providedPath;
    throw new Error(`Node.js executable not found at: ${providedPath}`);
  }

  // Check if 'node' is on PATH
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
    if (nodePath && fs.existsSync(nodePath)) return nodePath;
  } catch { /* not found via which */ }

  // Check common locations
  const commonPaths = [
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    'Node.js executable not found. Install Node.js (>=18) or provide nodePath option.\n' +
    'The LibreOffice WASM module requires Node.js for execution due to a Bun runtime\n' +
    'compatibility limitation with Emscripten-generated WebAssembly pthreads.'
  );
}

export class BunSubprocessConverter {
  private child: ChildProcess | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private options: BunSubprocessConverterOptions;
  private initialized = false;
  private initializing = false;
  private workerPath = '';
  private nodePath = '';

  constructor(options: BunSubprocessConverterOptions = {}) {
    this.options = {
      wasmPath: './wasm',
      verbose: false,
      maxInitRetries: 3,
      maxConversionRetries: 2,
      restartOnMemoryError: true,
      ...options,
    };
  }

  private isMemoryError(error: string | Error): boolean {
    const msg = error instanceof Error ? error.message : error;
    return msg.includes('memory access out of bounds') ||
      msg.includes('unreachable') ||
      msg.includes('table index is out of bounds') ||
      msg.includes('null function');
  }

  /**
   * Resolve the path to the subprocess.worker.cjs file.
   * In compiled Bun executables, import.meta.url points to the virtual /$bunfs/ filesystem,
   * so we fall back to checking common locations relative to CWD and the executable.
   */
  private resolveWorkerPath(): string {
    if (this.workerPath) return this.workerPath;

    const candidates: string[] = [];

    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      // Skip virtual filesystem paths (compiled Bun binaries)
      if (!currentDir.startsWith('/$bunfs')) {
        if (currentDir.endsWith('/src') || currentDir.endsWith('\\src')) {
          candidates.push(join(currentDir, '..', 'dist', 'subprocess.worker.cjs'));
        } else {
          candidates.push(join(currentDir, 'subprocess.worker.cjs'));
        }
      }
    } catch { /* ignore */ }

    // Fallback: check relative to CWD (common for compiled executables)
    candidates.push(
      join(process.cwd(), 'dist', 'subprocess.worker.cjs'),
      join(process.cwd(), 'node_modules', '@matbee', 'libreoffice-converter', 'dist', 'subprocess.worker.cjs'),
    );

    // Fallback: check relative to the real executable path
    try {
      const execDir = dirname(fs.realpathSync(process.execPath));
      candidates.push(join(execDir, 'dist', 'subprocess.worker.cjs'));
      candidates.push(join(execDir, 'subprocess.worker.cjs'));
    } catch { /* ignore */ }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.workerPath = candidate;
        return this.workerPath;
      }
    }

    throw new Error(
      `Subprocess worker not found. Searched:\n${candidates.map(c => `  - ${c}`).join('\n')}\n` +
      'Make sure the package is properly built (npm run build).'
    );
  }

  private async spawnWorker(): Promise<void> {
    if (!this.nodePath) {
      this.nodePath = findNodeExecutable(this.options.nodePath);
    }

    const workerPath = this.resolveWorkerPath();
    const wasmPath = resolve(this.options.wasmPath || './wasm');

    if (this.options.verbose) {
      console.error('[BunSubprocessConverter] Node.js:', this.nodePath);
      console.error('[BunSubprocessConverter] Worker:', workerPath);
      console.error('[BunSubprocessConverter] WASM:', wasmPath);
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
      if (code !== 0) {
        for (const p of this.pending.values()) p.reject(new Error(`Subprocess exited with code ${code}`));
        this.pending.clear();
      }
      this.child = null;
      this.initialized = false;
    });

    // Wait for 'ready' signal
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Subprocess start timeout (30s)')), 30000);
      const h = (msg: WorkerMessage) => {
        if (msg.type === 'ready') { clearTimeout(t); this.child?.off('message', h); resolve(); }
        else if (msg.type === 'error') { clearTimeout(t); this.child?.off('message', h); reject(new Error(msg.error)); }
      };
      this.child?.on('message', h);
    });

    // Build init payload
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

    // Send init to start WASM loading (3 minute timeout)
    await this.send('init', initPayload, 180000);
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
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
    }

    this.initializing = false;
    const err = new ConversionError(
      ConversionErrorCode.WASM_NOT_INITIALIZED,
      `Init failed after ${maxRetries} attempts: ${lastError?.message}`
    );
    this.options.onError?.(err);
    throw err;
  }

  private send(type: string, payload?: unknown, timeout = 300000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'No subprocess'));
        return;
      }
      const id = randomUUID();
      this.pending.set(id, { resolve, reject });
      this.child.send({ type, id, payload });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, `Timeout (${timeout}ms)`));
        }
      }, timeout);
    });
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
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }

    const start = Date.now();
    const data = this.normalizeInput(input);
    if (data.length === 0) {
      throw new ConversionError(ConversionErrorCode.INVALID_INPUT, 'Empty input');
    }

    const ext = options.inputFormat || (filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : 'docx');
    let filter = FORMAT_FILTER_OPTIONS[options.outputFormat] || '';
    if (options.outputFormat === 'pdf' && options.pdf) {
      const o: string[] = [];
      if (options.pdf.pdfaLevel) o.push(`SelectPdfVersion=${{ 'PDF/A-1b': 1, 'PDF/A-2b': 2, 'PDF/A-3b': 3 }[options.pdf.pdfaLevel] || 0}`);
      if (options.pdf.quality !== undefined) o.push(`Quality=${options.pdf.quality}`);
      if (o.length) filter = o.join(',');
    }

    const maxRetries = this.options.maxConversionRetries || 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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

        if (this.options.verbose) {
          console.error(`[BunSubprocessConverter] Conversion attempt ${attempt}/${maxRetries} failed:`, lastError.message);
        }

        if (this.isMemoryError(lastError) && this.options.restartOnMemoryError && attempt < maxRetries) {
          this.killWorker();
          await this.spawnWorker();
          this.initialized = true;
        } else if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }

    throw lastError || new ConversionError(ConversionErrorCode.CONVERSION_FAILED, 'Conversion failed');
  }

  /**
   * Get the number of pages in a document
   */
  async getPageCount(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: InputFormatOptions
  ): Promise<number> {
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }
    const inputData = this.normalizeInput(input);
    return this.send('getPageCount', {
      inputData: Array.from(inputData),
      inputFormat: options.inputFormat,
    }) as Promise<number>;
  }

  /**
   * Render page previews as RGBA pixel data
   */
  async renderPagePreviews(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: InputFormatOptions,
    renderOptions: { width?: number; height?: number; pageIndices?: number[] } = {}
  ): Promise<Array<{ page: number; data: Uint8Array; width: number; height: number }>> {
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }

    const inputData = this.normalizeInput(input);
    const result = await this.send('renderPagePreviews', {
      inputData: Array.from(inputData),
      inputFormat: options.inputFormat,
      width: renderOptions.width || 800,
      height: renderOptions.height || 0,
      pageIndices: renderOptions.pageIndices,
    }) as Array<{ page: number; data: number[]; width: number; height: number }>;

    return result.map(preview => ({
      page: preview.page,
      data: new Uint8Array(preview.data),
      width: preview.width,
      height: preview.height,
    }));
  }

  async destroy(): Promise<void> {
    if (this.child) {
      try {
        await this.send('destroy', undefined, 10000);
      } catch {
        // Subprocess may have already exited
      }
      if (this.child) {
        try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
        this.child = null;
      }
    }
    this.initialized = false;
    this.pending.clear();
  }

  isReady(): boolean {
    return this.initialized && this.child !== null;
  }
}

export async function createBunSubprocessConverter(
  options: BunSubprocessConverterOptions = {}
): Promise<BunSubprocessConverter> {
  const c = new BunSubprocessConverter(options);
  await c.initialize();
  return c;
}
