/**
 * Bun-Compatible Subprocess Converter
 *
 * This converter is designed to work in Bun environments where the standard
 * SubprocessConverter may not work because Bun 1.x has known incompatibilities
 * with Emscripten-generated WASM pthread workers.
 *
 * Architecture:
 *   - In Bun: forks a Node.js subprocess to run the WASM worker, side-stepping
 *     Bun's WASM/worker_threads pthread limitation.
 *   - In Node.js: behaves exactly like SubprocessConverter (passes through).
 *   - In compiled Bun single-file binaries: still forks Node.js, resolving the
 *     worker CJS path relative to the binary or the WASM directory.
 *
 * Node.js path resolution order:
 *   1. process.env.LOK_NODE_PATH
 *   2. Common locations (/usr/bin/node, /usr/local/bin/node, ~/.local/bin/node)
 *   3. Falls back to 'node' (relies on PATH)
 */

import { fork, ChildProcess } from 'child_process';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  ConversionError,
  ConversionErrorCode,
  ConversionOptions,
  ConversionResult,
  DocumentInfo,
  EditorOperationResult,
  EditorSession,
  FORMAT_MIME_TYPES,
  FullQualityPagePreview,
  FullQualityRenderOptions,
  OUTPUT_FORMAT_TO_LOK,
  FORMAT_FILTER_OPTIONS,
  ILibreOfficeConverter,
  InputFormatOptions,
  LibreOfficeWasmOptions,
  LOKDocumentType,
  OutputFormat,
  PagePreview,
  RenderOptions,
} from './types.js';

export type { LOKDocumentType, OutputFormat, PagePreview, DocumentInfo, EditorSession, RenderOptions };

interface WorkerMessage {
  type: 'ready' | 'error' | 'response';
  id?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
}

interface BunSubprocessConverterOptions extends LibreOfficeWasmOptions {
  /** Path to the Node.js executable (auto-detected if not set) */
  nodePath?: string;
  /** Max retries for initialization (default: 3) */
  maxInitRetries?: number;
  /** Max retries for conversion (default: 2) */
  maxConversionRetries?: number;
  /** Whether to restart subprocess on memory errors (default: true) */
  restartOnMemoryError?: boolean;
}

/**
 * Find the Node.js executable path.
 * Tries: LOK_NODE_PATH env, common locations, then falls back to 'node' on PATH.
 */
function findNodeExecutable(hint?: string): string {
  if (hint) return hint;
  if (process.env.LOK_NODE_PATH) return process.env.LOK_NODE_PATH;

  const candidates = [
    process.execPath,                     // current process (may be bun)
    '/usr/bin/node',
    '/usr/local/bin/node',
    `${process.env.HOME}/.local/bin/node`,
    '/nix/var/nix/profiles/default/bin/node',
  ];

  for (const c of candidates) {
    // Skip the Bun binary itself
    if (c && !c.includes('bun') && existsSync(c)) {
      return c;
    }
  }

  // Last resort: rely on PATH
  return 'node';
}

/**
 * Detect whether the current process is Bun (not Node.js).
 */
function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined' ||
    !!(process as NodeJS.Process & { isBun?: boolean }).isBun;
}

/**
 * Resolve the path to dist/subprocess.worker.cjs.
 * Works from src/, dist/, and compiled binary locations.
 */
function resolveWorkerPath(): string {
  // Use __dirname when available (CommonJS context)
  try {
    // Try import.meta.url first (ESM)
    const { fileURLToPath } = require('url') as typeof import('url');
    const currentDir = dirname(fileURLToPath(import.meta.url));
    if (currentDir.endsWith('/src') || currentDir.endsWith('\\src')) {
      return join(currentDir, '..', 'dist', 'subprocess.worker.cjs');
    }
    return join(currentDir, 'subprocess.worker.cjs');
  } catch {
    // Fallback for CJS context
    return join(__dirname, 'subprocess.worker.cjs');
  }
}

/**
 * A drop-in replacement for SubprocessConverter that works in Bun environments
 * by explicitly spawning a Node.js child process for the LibreOffice WASM worker.
 */
export class BunSubprocessConverter implements ILibreOfficeConverter {
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

  private async spawnWorker(): Promise<void> {
    if (!this.workerPath) {
      this.workerPath = resolveWorkerPath();
    }

    // When running under Bun, always use an explicit Node.js binary to avoid
    // Bun's WASM pthread incompatibility.
    if (!this.nodePath) {
      this.nodePath = isBunRuntime()
        ? findNodeExecutable(this.options.nodePath)
        : process.execPath;
    }

    const wasmPath = resolve(this.options.wasmPath || './wasm');

    const forkOptions: Parameters<typeof fork>[2] = {
      env: {
        ...process.env,
        WASM_PATH: wasmPath,
        VERBOSE: String(this.options.verbose || false),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    };

    // Only set execPath when it's different from the current process (i.e., Bun → node)
    if (isBunRuntime()) {
      forkOptions.execPath = this.nodePath;
    }

    this.child = fork(this.workerPath, [], forkOptions);

    this.child.stdout?.on('data', (d: Buffer) => {
      if (this.options.verbose) process.stdout.write(d);
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      if (this.options.verbose) process.stderr.write(d);
    });

    this.child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'response' && msg.id) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.success
            ? p.resolve(msg.data)
            : p.reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, msg.error || 'Error'));
        }
      }
    });

    this.child.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    this.child.on('exit', (code) => {
      if (code !== 0) {
        for (const p of this.pending.values()) p.reject(new Error(`Exit ${code}`));
        this.pending.clear();
      }
      this.child = null;
      this.initialized = false;
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Subprocess start timeout')), 30000);
      const h = (msg: WorkerMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(t);
          this.child?.off('message', h);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(t);
          this.child?.off('message', h);
          reject(new Error(msg.error));
        }
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

  private killWorker(): void {
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
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
    const err = new ConversionError(
      ConversionErrorCode.WASM_NOT_INITIALIZED,
      `Init failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
    this.options.onError?.(err);
    throw err;
  }

  private send(type: string, payload?: unknown, timeout = 300000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'No process'));
        return;
      }
      const id = randomUUID();
      this.pending.set(id, { resolve, reject });
      this.child.send({ type, id, payload });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, 'Timeout'));
        }
      }, timeout);
    });
  }

  private normalizeInput(input: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return new Uint8Array(input);
  }

  async convert(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: ConversionOptions,
    filename = 'document',
  ): Promise<ConversionResult> {
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }

    const start = Date.now();
    const data = this.normalizeInput(input);
    if (data.length === 0) throw new ConversionError(ConversionErrorCode.INVALID_INPUT, 'Empty');

    const ext = options.inputFormat ||
      (filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : 'docx');
    let filter = FORMAT_FILTER_OPTIONS[options.outputFormat] || '';
    if (options.outputFormat === 'pdf' && options.pdf) {
      const o: string[] = [];
      if (options.pdf.pdfaLevel) {
        o.push(`SelectPdfVersion=${{ 'PDF/A-1b': 1, 'PDF/A-2b': 2, 'PDF/A-3b': 3 }[options.pdf.pdfaLevel] || 0}`);
      }
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

  async getPageCount(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions): Promise<number> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('getPageCount', { inputData: Array.from(this.normalizeInput(input)), inputFormat: options.inputFormat }) as Promise<number>;
  }

  async getDocumentInfo(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions): Promise<DocumentInfo> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('getDocumentInfo', { inputData: Array.from(this.normalizeInput(input)), inputFormat: options.inputFormat }) as Promise<DocumentInfo>;
  }

  async renderPage(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions, pageIndex: number, width: number, height = 0): Promise<PagePreview> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    const result = await this.send('renderPage', {
      inputData: Array.from(this.normalizeInput(input)),
      inputFormat: options.inputFormat,
      pageIndex, width, height,
    }) as { data: number[]; width: number; height: number };
    return { page: pageIndex, data: new Uint8Array(result.data), width: result.width, height: result.height };
  }

  async renderPagePreviews(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions, renderOptions: RenderOptions = {}): Promise<PagePreview[]> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    const result = await this.send('renderPagePreviews', {
      inputData: Array.from(this.normalizeInput(input)),
      inputFormat: options.inputFormat,
      width: renderOptions.width || 800,
      height: renderOptions.height || 0,
      pageIndices: renderOptions.pageIndices,
    }) as Array<{ page: number; data: number[]; width: number; height: number }>;
    return result.map(p => ({ page: p.page, data: new Uint8Array(p.data), width: p.width, height: p.height }));
  }

  async renderPageFullQuality(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions, pageIndex: number, renderOptions: FullQualityRenderOptions = {}): Promise<FullQualityPagePreview> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    const result = await this.send('renderPageFullQuality', {
      inputData: Array.from(this.normalizeInput(input)),
      inputFormat: options.inputFormat,
      pageIndex,
      dpi: renderOptions.dpi ?? 150,
      maxDimension: renderOptions.maxDimension,
      editMode: renderOptions.editMode ?? false,
    }) as { page: number; data: number[]; width: number; height: number; dpi: number };
    return { page: result.page, data: new Uint8Array(result.data), width: result.width, height: result.height, dpi: result.dpi };
  }

  async getDocumentText(input: Uint8Array | ArrayBuffer | Buffer, inputFormat: string): Promise<string | null> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('getDocumentText', { inputData: Array.from(this.normalizeInput(input)), inputFormat }) as Promise<string | null>;
  }

  async getPageNames(input: Uint8Array | ArrayBuffer | Buffer, inputFormat: string): Promise<string[]> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('getPageNames', { inputData: Array.from(this.normalizeInput(input)), inputFormat }) as Promise<string[]>;
  }

  async openDocument(input: Uint8Array | ArrayBuffer | Buffer, options: InputFormatOptions): Promise<EditorSession> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('openDocument', { inputData: Array.from(this.normalizeInput(input)), inputFormat: options.inputFormat }) as Promise<EditorSession>;
  }

  async editorOperation<T = unknown>(sessionId: string, method: string, args?: unknown[]): Promise<EditorOperationResult<T>> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    return this.send('editorOperation', { sessionId, method, args: args ?? [] }) as Promise<EditorOperationResult<T>>;
  }

  async closeDocument(sessionId: string): Promise<Uint8Array | undefined> {
    if (!this.initialized || !this.child) throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    const result = await this.send('closeDocument', { sessionId }) as number[] | undefined;
    return result ? new Uint8Array(result) : undefined;
  }

  async destroy(): Promise<void> {
    if (this.child) {
      try { await this.send('destroy'); } catch { /* ignore */ }
      if (this.child) {
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
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
  options: BunSubprocessConverterOptions = {},
): Promise<BunSubprocessConverter> {
  const c = new BunSubprocessConverter(options);
  await c.initialize();
  return c;
}
