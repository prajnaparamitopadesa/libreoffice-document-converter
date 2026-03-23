/**
 * LibreOffice WASM Document Converter - Bun Entry Point
 *
 * Provides Bun-compatible converter that works in both:
 * - Script mode: `bun examples/bun-conversion.ts`
 * - Compiled single-file mode: `bun build --compile` then `./binary`
 *
 * Uses a subprocess architecture with JSON-line IPC over stdin/stdout.
 * For compiled binaries, the executable re-spawns itself with `--bun-subprocess`
 * to run the WASM worker in a child process, ensuring clean process exit.
 *
 * All APIs use Node.js-compatible interfaces (child_process, streams) which
 * Bun fully supports, so no Bun-specific runtime types are needed.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import type {
  ConversionOptions,
  ConversionResult,
  LibreOfficeWasmOptions,
} from './types.js';
import {
  ConversionError,
  ConversionErrorCode,
  FORMAT_MIME_TYPES,
  OUTPUT_FORMAT_TO_LOK,
  FORMAT_FILTER_OPTIONS,
} from './types.js';

// ============================================
// Subprocess detection helpers
// ============================================

/** The flag used to identify subprocess mode */
const BUN_SUBPROCESS_FLAG = '--bun-subprocess';

/**
 * Check if the current process was launched as a Bun subprocess worker.
 * Use this at the entry point of your application to route between
 * main logic and subprocess worker mode.
 *
 * @example
 * ```typescript
 * import { isBunSubprocess, runBunSubprocessWorker } from '@matbee/libreoffice-converter/bun';
 *
 * if (isBunSubprocess()) {
 *   await runBunSubprocessWorker();
 * }
 *
 * // ... main application logic
 * ```
 */
export function isBunSubprocess(): boolean {
  return process.argv.includes(BUN_SUBPROCESS_FLAG);
}

// ============================================
// IPC Protocol Types
// ============================================

interface IPCRequest {
  type: 'init' | 'convert' | 'getPageCount' | 'destroy';
  id: string;
  payload?: unknown;
}

interface IPCResponse {
  type: 'ready' | 'response' | 'error';
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface InitPayload {
  verbose: boolean;
}

interface ConvertPayload {
  inputData: number[];
  inputExt: string;
  outputFormat: string;
  filterOptions: string;
}

interface PageCountPayload {
  inputData: number[];
  inputFormat: string;
}

// ============================================
// Subprocess Worker
// ============================================

/**
 * Run the Bun subprocess worker. Call this at the top of your entry point
 * when `isBunSubprocess()` returns true.
 *
 * The worker loads the WASM module, handles conversion requests via
 * JSON-line IPC over stdin/stdout, and exits cleanly when told to destroy.
 *
 * @param options - Worker options
 * @param options.wasmPath - Path to the wasm/ directory (default: './wasm')
 * @param options.verbose - Enable verbose logging to stderr
 */
export async function runBunSubprocessWorker(options?: {
  wasmPath?: string;
  verbose?: boolean;
}): Promise<void> {
  const wasmPath = options?.wasmPath || process.env.WASM_PATH || './wasm';
  const verbose = options?.verbose || process.env.VERBOSE === 'true';
  const resolvedWasmPath = resolve(wasmPath);

  // CRITICAL: Redirect console.log to stderr in the subprocess.
  // stdout is reserved exclusively for JSON-line IPC messages.
  // The WASM loader and converter use console.log for verbose output,
  // which would corrupt the IPC protocol if sent to stdout.
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };

  const log = (...args: unknown[]) => {
    if (verbose) console.error('[BunSubprocessWorker]', ...args);
  };

  // Write a JSON response to stdout (one line) - the ONLY thing that writes to stdout
  const sendResponse = (response: IPCResponse) => {
    const line = JSON.stringify(response) + '\n';
    process.stdout.write(line);
  };

  log('Starting worker, wasmPath:', resolvedWasmPath);

  // Import LibreOfficeConverter (bundled into the binary for compiled mode)
  const { LibreOfficeConverter } = await import('./converter-node.js');

  // Load the WASM loader from disk at runtime
  const loaderPath = join(resolvedWasmPath, 'loader.cjs');
  if (!existsSync(loaderPath)) {
    sendResponse({ type: 'error', error: `WASM loader not found: ${loaderPath}` });
    console.log = originalConsoleLog;
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wasmLoader = require(loaderPath);

  let converter: InstanceType<typeof LibreOfficeConverter> | null = null;

  // Signal ready
  sendResponse({ type: 'ready' });

  // Handle messages from stdin (JSON lines)
  let buffer = '';

  const processMessage = async (msg: IPCRequest): Promise<void> => {
    try {
      let result: unknown;

      switch (msg.type) {
        case 'init': {
          const payload = msg.payload as InitPayload | undefined;
          if (!converter) {
            log('Creating converter...');
            converter = new LibreOfficeConverter({
              wasmPath: resolvedWasmPath,
              verbose: payload?.verbose ?? verbose,
              wasmLoader,
            });
            log('Initializing converter...');
            await converter.initialize();
            log('Converter ready');
          }
          break;
        }

        case 'convert': {
          if (!converter?.isReady()) {
            throw new Error('Not initialized');
          }
          const payload = msg.payload as ConvertPayload;
          const inputData = new Uint8Array(payload.inputData);
          const convertResult = await converter.convert(
            inputData,
            {
              inputFormat: payload.inputExt,
              outputFormat: payload.outputFormat,
            } as ConversionOptions,
            'document'
          );
          result = Array.from(convertResult.data);
          break;
        }

        case 'getPageCount': {
          if (!converter?.isReady()) {
            throw new Error('Not initialized');
          }
          const payload = msg.payload as PageCountPayload;
          const inputData = new Uint8Array(payload.inputData);
          result = await converter.getPageCount(inputData, {
            inputFormat: payload.inputFormat,
            outputFormat: 'pdf',
          } as ConversionOptions);
          break;
        }

        case 'destroy': {
          if (converter) {
            await converter.destroy();
            converter = null;
          }
          sendResponse({ type: 'response', id: msg.id, success: true });
          log('Destroy complete, exiting');
          setTimeout(() => process.exit(0), 50);
          return;
        }

        default:
          throw new Error(`Unknown message type: ${msg.type}`);
      }

      sendResponse({ type: 'response', id: msg.id, success: true, data: result });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log('Error:', errorMsg);
      sendResponse({ type: 'response', id: msg.id, success: false, error: errorMsg });
    }
  };

  // Read from stdin as a stream (Node.js readable stream API, supported by Bun)
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as IPCRequest;
          await processMessage(msg);
        } catch (parseErr) {
          log('Invalid message:', line, parseErr);
        }
      }
    }
  });

  process.stdin.on('end', async () => {
    // stdin closed - clean up and exit
    if (converter) {
      await converter.destroy();
    }
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {
    // This promise never resolves - the process exits via process.exit()
  });
}

// ============================================
// BunSubprocessConverter
// ============================================

interface BunSubprocessConverterOptions extends LibreOfficeWasmOptions {
  /** Max retries for initialization (default: 3) */
  maxInitRetries?: number;
  /** Max retries for conversion (default: 2) */
  maxConversionRetries?: number;
  /**
   * Path to the entry script for script mode.
   * In compiled binary mode, the executable re-spawns itself automatically.
   * In script mode, you must provide the path to your entry script
   * (the file that calls isBunSubprocess() + runBunSubprocessWorker()).
   */
  entryScript?: string;
}

/**
 * Bun-compatible subprocess converter.
 *
 * Spawns a child process that loads the LibreOffice WASM module.
 * Communicates with the child via JSON-line IPC over stdin/stdout.
 *
 * For compiled binaries (`bun build --compile`), the executable re-spawns itself
 * with the `--bun-subprocess` flag. For script mode, provide the entry script path.
 *
 * @example
 * ```typescript
 * const converter = await createBunConverter({
 *   wasmPath: './wasm',
 *   entryScript: import.meta.filename, // required for script mode
 * });
 *
 * const result = await converter.convert(pptxBuffer, { outputFormat: 'png' });
 * await converter.destroy();
 * ```
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
  private responseBuffer = '';
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

  /**
   * Detect if running as a Bun compiled binary.
   * In compiled mode, process.execPath does NOT end with 'bun' or 'bun.exe'.
   */
  private isCompiledBinary(): boolean {
    const execBase = process.execPath.replace(/\\/g, '/').split('/').pop() || '';
    return execBase !== 'bun' && execBase !== 'bun.exe';
  }

  private generateId(): string {
    return `msg_${++this.idCounter}_${Date.now()}`;
  }

  private async spawnWorker(): Promise<void> {
    const wasmPath = resolve(this.options.wasmPath || './wasm');

    // Determine how to spawn the subprocess
    let command: string;
    let args: string[];
    if (this.isCompiledBinary()) {
      // Compiled mode: re-run ourselves with subprocess flag
      command = process.execPath;
      args = [BUN_SUBPROCESS_FLAG];
    } else if (this.options.entryScript) {
      // Script mode: run the entry script with bun
      command = process.execPath;
      args = ['run', this.options.entryScript, BUN_SUBPROCESS_FLAG];
    } else {
      throw new ConversionError(
        ConversionErrorCode.WASM_NOT_INITIALIZED,
        'entryScript is required in script mode. Pass the path to your entry script ' +
        'that calls isBunSubprocess() + runBunSubprocessWorker().'
      );
    }

    if (this.options.verbose) {
      console.error('[BunSubprocessConverter] Spawning:', command, args.join(' '));
    }

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', this.options.verbose ? 'inherit' : 'pipe'],
      env: {
        ...process.env,
        WASM_PATH: wasmPath,
        VERBOSE: String(this.options.verbose || false),
      },
    });

    // Read responses from stdout
    this.startReadingResponses();

    // Handle child errors and exit
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

    // Wait for ready signal
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Subprocess start timeout (30s)')), 30000);
      const checkReady = (response: IPCResponse) => {
        if (response.type === 'ready') {
          clearTimeout(timeout);
          resolve();
          return true;
        }
        if (response.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(response.error || 'Subprocess error'));
          return true;
        }
        return false;
      };

      // Store a temporary handler
      this._readyHandler = checkReady;
    });
    this._readyHandler = null;

    // Send init message
    await this.send('init', { verbose: this.options.verbose }, 180000);
  }

  private _readyHandler: ((r: IPCResponse) => boolean) | null = null;

  private startReadingResponses(): void {
    if (!this.child?.stdout) return;

    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => {
      this.responseBuffer += chunk;

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = this.responseBuffer.indexOf('\n')) !== -1) {
        const line = this.responseBuffer.slice(0, newlineIdx).trim();
        this.responseBuffer = this.responseBuffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          try {
            const response = JSON.parse(line) as IPCResponse;
            this.handleResponse(response);
          } catch {
            // Not valid JSON, ignore
          }
        }
      }
    });

    this.child.stdout.on('end', () => {
      // Process exited - reject all pending
      for (const p of this.pending.values()) {
        p.reject(new Error('Subprocess exited'));
      }
      this.pending.clear();
      this.initialized = false;
    });
  }

  private handleResponse(response: IPCResponse): void {
    // Check ready handler first
    if (this._readyHandler && this._readyHandler(response)) {
      return;
    }

    if (response.type === 'response' && response.id) {
      const p = this.pending.get(response.id);
      if (p) {
        this.pending.delete(response.id);
        if (response.success) {
          p.resolve(response.data);
        } else {
          p.reject(new ConversionError(
            ConversionErrorCode.CONVERSION_FAILED,
            response.error || 'Conversion failed'
          ));
        }
      }
    }
  }

  private send(type: string, payload?: unknown, timeout = 300000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin) {
        reject(new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'No subprocess'));
        return;
      }

      const id = this.generateId();
      this.pending.set(id, { resolve, reject });

      const msg: IPCRequest = { type: type as IPCRequest['type'], id, payload };
      const line = JSON.stringify(msg) + '\n';

      const writeOk = this.child.stdin.write(line);
      if (!writeOk) {
        // Backpressure - wait for drain. This is unlikely for small messages.
        this.child.stdin.once('drain', () => { /* continue */ });
      }

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, `Timeout after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  private killWorker(): void {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already dead
      }
      this.child = null;
    }
    this.initialized = false;
    this.pending.clear();
    this.responseBuffer = '';
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
    throw new ConversionError(
      ConversionErrorCode.WASM_NOT_INITIALIZED,
      `Init failed after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  private normalizeInput(input: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
    if (input instanceof Uint8Array) return input;
    return new Uint8Array(input);
  }

  /**
   * Convert a document to another format.
   */
  async convert(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: ConversionOptions,
    filename = 'document'
  ): Promise<ConversionResult> {
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }

    const data = this.normalizeInput(input);
    if (data.length === 0) {
      throw new ConversionError(ConversionErrorCode.INVALID_INPUT, 'Empty input');
    }

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
        if (this.options.verbose) {
          console.error(`[BunSubprocessConverter] Conversion attempt ${attempt}/${maxRetries} failed:`, lastError.message);
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }

    throw lastError || new ConversionError(ConversionErrorCode.CONVERSION_FAILED, 'Conversion failed');
  }

  /**
   * Get the number of pages in a document.
   */
  async getPageCount(
    input: Uint8Array | ArrayBuffer | Buffer,
    inputFormat: string
  ): Promise<number> {
    if (!this.initialized || !this.child) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Not initialized');
    }

    const data = this.normalizeInput(input);
    return this.send('getPageCount', {
      inputData: Array.from(data),
      inputFormat,
    }) as Promise<number>;
  }

  /**
   * Destroy the converter and kill the subprocess.
   */
  async destroy(): Promise<void> {
    if (this.child) {
      try {
        await this.send('destroy', undefined, 10000);
      } catch {
        // Child may have already exited
      }

      // Give child time to exit gracefully, then force kill
      await new Promise(r => setTimeout(r, 100));
      this.killWorker();
    }
    this.initialized = false;
    this.pending.clear();
  }

  isReady(): boolean {
    return this.initialized && this.child !== null;
  }
}

/**
 * Create and initialize a Bun subprocess converter.
 *
 * @example
 * ```typescript
 * import { createBunConverter } from '@matbee/libreoffice-converter/bun';
 *
 * const converter = await createBunConverter({
 *   wasmPath: './wasm',
 *   entryScript: import.meta.filename,
 * });
 *
 * const result = await converter.convert(docxBuffer, { outputFormat: 'pdf' });
 * await converter.destroy();
 * ```
 */
export async function createBunConverter(
  options: BunSubprocessConverterOptions = {}
): Promise<BunSubprocessConverter> {
  const converter = new BunSubprocessConverter(options);
  await converter.initialize();
  return converter;
}

// Re-export types for convenience
export type {
  ConversionOptions,
  ConversionResult,
  LibreOfficeWasmOptions,
} from './types.js';

export {
  ConversionError,
  ConversionErrorCode,
  FORMAT_MIME_TYPES,
} from './types.js';
