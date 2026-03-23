import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { LibreOfficeConverter } from './converter-node.js';
import {
  ConversionError,
  ConversionErrorCode,
  FORMAT_MIME_TYPES,
} from './types.js';
import type {
  ConversionOptions,
  ConversionResult,
  InputFormatOptions,
  LibreOfficeWasmOptions,
  ProgressInfo,
  WasmLoaderModule,
} from './types.js';

export type {
  ConversionOptions,
  ConversionResult,
  InputFormat,
  InputFormatOptions,
  LibreOfficeWasmOptions,
  OutputFormat,
  ProgressInfo,
} from './types.js';

interface BunFileLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream?(): ReadableStream<Uint8Array>;
}

interface BunSpawnedProcess {
  stdin: { write(chunk: string): number; end(): void } | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string): void;
}

interface BunGlobalLike {
  argv: string[];
  main: string;
  stdin: { stream(): ReadableStream<Uint8Array> };
  file(path: string | URL): BunFileLike;
  spawn(options: {
    cmd: string[];
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    env?: Record<string, string>;
  }): BunSpawnedProcess;
}

export interface BunWasmAssets {
  /** JavaScript glue source from wasm/soffice.cjs */
  sofficeSource: string;
  /** Path returned by Bun file-loader import or a real file path */
  sofficeWasmPath: string;
  /** Path returned by Bun file-loader import or a real file path */
  sofficeDataPath: string;
}

export interface BunSubprocessConverterOptions extends LibreOfficeWasmOptions {
  /** Override the entrypoint used when self-spawning from Bun script mode */
  entrypoint?: string;
  /** Embedded or file-loader based assets for Bun --compile mode */
  assets?: BunWasmAssets;
}

export interface RunBunSubprocessOptions {
  /** Embedded or file-loader based assets for Bun --compile mode */
  assets?: BunWasmAssets;
}

interface SubprocessRequest {
  id: string;
  type: 'init' | 'convert' | 'getPageCount' | 'destroy';
  payload?: unknown;
}

interface SubprocessResponse {
  id?: string;
  type: 'ready' | 'response' | 'error';
  success?: boolean;
  error?: string;
  data?: unknown;
}

interface InitPayload {
  options?: LibreOfficeWasmOptions;
}

interface ConvertPayload {
  input: string;
  options: ConversionOptions;
  filename?: string;
}

interface PageCountPayload {
  input: string;
  options: InputFormatOptions;
}

interface BunRuntimeState {
  process: typeof process;
  window?: unknown;
  self?: unknown;
  document?: unknown;
  location?: unknown;
  workerGlobalScope?: unknown;
}

const BUN_SUBPROCESS_FLAG = '--libreoffice-bun-subprocess';

export function getBunGlobal(): BunGlobalLike {
  const bun = (globalThis as { Bun?: BunGlobalLike }).Bun;
  if (!bun) {
    throw new ConversionError(
      ConversionErrorCode.WASM_NOT_INITIALIZED,
      'Bun runtime is required. Use @matbee/libreoffice-converter/bun from Bun.'
    );
  }
  return bun;
}

export function encodeBinary(input: Uint8Array): string {
  return Buffer.from(input).toString('base64');
}

export function decodeBinary(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64'));
}

export function normalizeInput(input: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input);
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield line;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }

    const remainder = buffer.trim();
    if (remainder) {
      yield remainder;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readTextFile(path: string | URL): Promise<string> {
  return getBunGlobal().file(path).text();
}

async function readBinaryFile(path: string | URL): Promise<ArrayBuffer> {
  return getBunGlobal().file(path).arrayBuffer();
}

function getDefaultWasmPaths(): { sourcePath: URL; wasmPath: string; dataPath: string } {
  const sourcePath = new URL('../wasm/soffice.cjs', import.meta.url);
  const wasmPath = fileURLToPath(new URL('../wasm/soffice.wasm', import.meta.url));
  const dataPath = fileURLToPath(new URL('../wasm/soffice.data', import.meta.url));
  return { sourcePath, wasmPath, dataPath };
}

export async function createBunWasmAssets(): Promise<BunWasmAssets> {
  const defaults = getDefaultWasmPaths();
  return {
    sofficeSource: await readTextFile(defaults.sourcePath),
    sofficeWasmPath: defaults.wasmPath,
    sofficeDataPath: defaults.dataPath,
  };
}

function emitBunProgress(
  callback: ((phase: string, percent: number, message: string) => void) | undefined,
  phase: string,
  percent: number,
  message: string
): void {
  callback?.(phase, percent, message);
}

function captureRuntimeState(): BunRuntimeState {
  const state = globalThis as Record<string, unknown>;

  return {
    process,
    window: state.window,
    self: state.self,
    document: state.document,
    location: state.location,
    workerGlobalScope: state.WorkerGlobalScope,
  };
}

function restoreRuntimeState(state: BunRuntimeState): void {
  const target = globalThis as Record<string, unknown>;

  target.process = state.process;
  target.window = state.window;
  target.self = state.self;
  target.document = state.document;
  target.location = state.location;
  target.WorkerGlobalScope = state.workerGlobalScope;
}

function createBunBootstrapSource(source: string): string {
  return [
    'globalThis.process = { ...globalThis.process, versions: { ...globalThis.process.versions, node: undefined } };',
    'globalThis.self = globalThis;',
    'globalThis.WorkerGlobalScope = globalThis.WorkerGlobalScope || function WorkerGlobalScope() {};',
    "globalThis.self.name = 'em-pthread-bootstrap';",
    "globalThis.name = 'em-pthread-bootstrap';",
    "globalThis.location = { href: 'bun-bootstrap://soffice.cjs', pathname: '/soffice.cjs' };",
    source,
  ].join('\n');
}

export async function createBunLoader(assets?: BunWasmAssets): Promise<WasmLoaderModule> {
  const resolvedAssets = assets ?? await createBunWasmAssets();

  return {
    createModule: async (config: Record<string, unknown>) => {
      const state = captureRuntimeState();
      const fakeProcess = {
        ...process,
        versions: { ...process.versions, node: undefined },
      } as unknown as typeof process;
      const wasmBinary = await readBinaryFile(resolvedAssets.sofficeWasmPath);
      const dataBinary = await readBinaryFile(resolvedAssets.sofficeDataPath);
      const bootstrapUrl = URL.createObjectURL(
        new Blob([createBunBootstrapSource(resolvedAssets.sofficeSource)], { type: 'application/javascript' })
      );

      emitBunProgress(config.onProgress as ((phase: string, percent: number, message: string) => void) | undefined, 'starting', 0, 'Starting LibreOffice WASM...');
      emitBunProgress(config.onProgress as ((phase: string, percent: number, message: string) => void) | undefined, 'loading_wasm', 10, 'Loading Bun-compatible WASM assets...');

      try {
        const globalTarget = globalThis as Record<string, unknown>;
        const runningInsideWorker = typeof postMessage === 'function';
        globalTarget.process = fakeProcess;
        globalTarget.self = globalThis;
        globalTarget.WorkerGlobalScope = function WorkerGlobalScope() { };
        if (!runningInsideWorker) {
          globalTarget.window = globalThis;
          globalTarget.document = {
            currentScript: { src: 'bun-main://soffice.cjs' },
          };
        } else {
          delete globalTarget.window;
          delete globalTarget.document;
        }
        globalTarget.location = {
          href: runningInsideWorker ? 'bun-worker://soffice.cjs' : 'bun-main://soffice.cjs',
          pathname: '/soffice.cjs',
        };

        return await new Promise((resolve, reject) => {
          const moduleConfig = {
            ...config,
            wasmBinary,
            mainScriptUrlOrBlob: bootstrapUrl,
            getPreloadedPackage: (remoteName: string) => {
              if (String(remoteName).endsWith('soffice.data')) {
                return dataBinary;
              }
              return undefined;
            },
            locateFile: (filename: string) => {
              if (filename.endsWith('.wasm')) return resolvedAssets.sofficeWasmPath;
              if (filename.endsWith('.data')) return resolvedAssets.sofficeDataPath;
              return filename;
            },
            onRuntimeInitialized: () => {
              emitBunProgress(config.onProgress as ((phase: string, percent: number, message: string) => void) | undefined, 'runtime_ready', 45, 'WebAssembly runtime initialized');
              const module = (globalThis as { Module?: unknown }).Module;
              restoreRuntimeState(state);
              URL.revokeObjectURL(bootstrapUrl);
              const runtimeReady = config.onRuntimeInitialized;
              if (typeof runtimeReady === 'function') {
                runtimeReady();
              }
              resolve(module as Awaited<ReturnType<WasmLoaderModule['createModule']>>);
            },
          };

          (globalThis as Record<string, unknown>).Module = moduleConfig;

          try {
            (0, eval)(resolvedAssets.sofficeSource);
          } catch (error) {
            restoreRuntimeState(state);
            URL.revokeObjectURL(bootstrapUrl);
            reject(error);
          }
        });
      } catch (error) {
        restoreRuntimeState(state);
        URL.revokeObjectURL(bootstrapUrl);
        throw error;
      }
    },
  };
}

export async function createDirectBunConverter(options: BunSubprocessConverterOptions = {}): Promise<LibreOfficeConverter> {
  const loader = await createBunLoader(options.assets);
  const converter = new LibreOfficeConverter({
    ...options,
    wasmLoader: loader,
  });
  await converter.initialize();
  return converter;
}

function isCompiledBunExecutable(argv: readonly string[] = process.argv, bunMain?: string): boolean {
  const bunEntry = bunMain ?? (globalThis as { Bun?: BunGlobalLike }).Bun?.main;
  return Boolean(bunEntry && argv[0] && argv[0] === bunEntry);
}

export function isBunSubprocess(argv: readonly string[] = process.argv): boolean {
  return argv.includes(BUN_SUBPROCESS_FLAG);
}

export function getBunSubprocessCommand(
  entrypoint?: string,
  bunMain?: string,
  argv: readonly string[] = process.argv
): string[] {
  const resolvedEntrypoint = entrypoint ?? bunMain ?? getBunGlobal().main;
  if (isCompiledBunExecutable(argv, bunMain)) {
    return [process.execPath, BUN_SUBPROCESS_FLAG];
  }
  return [process.execPath, resolvedEntrypoint, BUN_SUBPROCESS_FLAG];
}

function getBunWorkerUrl(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const workerFile = currentDir.endsWith('/src') || currentDir.endsWith('\\src')
    ? 'bun.worker.ts'
    : 'bun.worker.js';
  return new URL(`./${workerFile}`, import.meta.url).href;
}

export class BunSubprocessConverter {
  private child: BunSpawnedProcess | null = null;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readyPromise: Promise<void> | null = null;
  private readonly options: BunSubprocessConverterOptions;

  constructor(options: BunSubprocessConverterOptions = {}) {
    this.options = { verbose: false, ...options };
  }

  private async start(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const child = getBunGlobal().spawn({
        cmd: getBunSubprocessCommand(this.options.entrypoint),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: process.env as Record<string, string>,
      });

      this.child = child;

      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Failed to create Bun subprocess pipes'));
        return;
      }

      void this.consumeResponses(child.stdout, resolve, reject);
      void this.consumeStderr(child.stderr);

      void child.exited.then((code) => {
        if (code !== 0 && this.pending.size > 0) {
          const error = new ConversionError(ConversionErrorCode.CONVERSION_FAILED, `Bun subprocess exited with code ${code}`);
          for (const pending of this.pending.values()) {
            pending.reject(error);
          }
          this.pending.clear();
        }
        this.child = null;
        this.readyPromise = null;
      });
    });

    await this.readyPromise;
    await this.send('init', { options: this.options } satisfies InitPayload);
  }

  private async consumeResponses(
    stream: ReadableStream<Uint8Array>,
    resolveReady: () => void,
    rejectReady: (error: Error) => void
  ): Promise<void> {
    try {
      for await (const line of readLines(stream)) {
        const message = JSON.parse(line) as SubprocessResponse;
        if (message.type === 'ready') {
          resolveReady();
          continue;
        }

        if (message.type === 'error') {
          rejectReady(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, message.error || 'Bun subprocess error'));
          continue;
        }

        if (message.type === 'response' && message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }
          this.pending.delete(message.id);
          if (message.success) {
            pending.resolve(message.data);
          } else {
            pending.reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, message.error || 'Bun subprocess request failed'));
          }
        }
      }
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async consumeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.options.verbose && value) {
          process.stderr.write(decoder.decode(value, { stream: true }));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async send(type: SubprocessRequest['type'], payload?: unknown): Promise<unknown> {
    if (!this.child?.stdin) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Bun subprocess is not running');
    }

    const id = randomUUID();
    const message: SubprocessRequest = { id, type, payload };
    const serialized = `${JSON.stringify(message)}\n`;

    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child?.stdin?.write(serialized);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async initialize(): Promise<void> {
    await this.start();
  }

  async convert(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: ConversionOptions,
    filename = 'document'
  ): Promise<ConversionResult> {
    await this.start();
    const payload: ConvertPayload = {
      input: encodeBinary(normalizeInput(input)),
      options,
      filename,
    };
    const response = await this.send('convert', payload) as {
      data: string;
      mimeType: string;
      filename: string;
      duration: number;
    };

    return {
      data: decodeBinary(response.data),
      mimeType: response.mimeType,
      filename: response.filename,
      duration: response.duration,
    };
  }

  async getPageCount(
    input: Uint8Array | ArrayBuffer | Buffer,
    options: InputFormatOptions
  ): Promise<number> {
    await this.start();
    return await this.send('getPageCount', {
      input: encodeBinary(normalizeInput(input)),
      options,
    } satisfies PageCountPayload) as number;
  }

  async destroy(): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.send('destroy');
    } catch {
      // Ignore teardown failures
    }

    try {
      this.child.stdin?.end();
    } catch {
      // Ignore teardown failures
    }

    try {
      this.child.kill();
    } catch {
      // Ignore teardown failures
    }

    this.child = null;
    this.readyPromise = null;
    this.pending.clear();
  }
}

export async function createBunSubprocessConverter(
  options: BunSubprocessConverterOptions = {}
): Promise<BunSubprocessConverter> {
  const converter = new BunSubprocessConverter(options);
  await converter.initialize();
  return converter;
}

export async function convertDocument(
  input: Uint8Array | ArrayBuffer | Buffer,
  options: ConversionOptions,
  converterOptions?: BunSubprocessConverterOptions
): Promise<ConversionResult> {
  const converter = await createBunSubprocessConverter(converterOptions);
  try {
    return await converter.convert(input, options);
  } finally {
    await converter.destroy();
  }
}

export async function exportAsImage(
  input: Uint8Array | ArrayBuffer | Buffer,
  pages: number | number[],
  format: 'png' | 'jpg' | 'svg' = 'png',
  imageOptions?: ConversionOptions['image'],
  converterOptions?: BunSubprocessConverterOptions
): Promise<ConversionResult[]> {
  const converter = await createBunSubprocessConverter(converterOptions);
  try {
    const pageList = Array.isArray(pages) ? pages : [pages];
    const results: ConversionResult[] = [];
    for (const pageIndex of pageList) {
      results.push(await converter.convert(input, {
        outputFormat: format,
        image: {
          ...imageOptions,
          pageIndex,
        },
      }));
    }
    return results;
  } finally {
    await converter.destroy();
  }
}

export async function runBunSubprocess(options: RunBunSubprocessOptions = {}): Promise<void> {
  const stdout = process.stdout;
  const stderr = process.stderr;

  const send = (message: SubprocessResponse): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  let worker: Worker | null = null;
  let workerMessageId = 0;
  const workerPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }

    worker = new Worker(getBunWorkerUrl());
    worker.onmessage = (event: MessageEvent<{ id: number; success: boolean; data?: unknown; error?: string }>) => {
      const pending = workerPending.get(event.data.id);
      if (!pending) {
        return;
      }
      workerPending.delete(event.data.id);
      if (event.data.success) {
        pending.resolve(event.data.data);
      } else {
        pending.reject(new ConversionError(ConversionErrorCode.CONVERSION_FAILED, event.data.error || 'Bun worker request failed'));
      }
    };
    worker.onerror = (event) => {
      const error = new ConversionError(ConversionErrorCode.CONVERSION_FAILED, event.message || 'Bun worker crashed');
      for (const pending of workerPending.values()) {
        pending.reject(error);
      }
      workerPending.clear();
    };

    return worker;
  };

  const sendWorkerRequest = async (type: string, payload?: unknown): Promise<unknown> => {
    const activeWorker = ensureWorker();
    const id = ++workerMessageId;
    return await new Promise((resolve, reject) => {
      workerPending.set(id, { resolve, reject });
      activeWorker.postMessage({ id, type, payload });
    });
  };

  send({ type: 'ready' });

  try {
    for await (const line of readLines(getBunGlobal().stdin.stream())) {
      const request = JSON.parse(line) as SubprocessRequest;

      try {
        if (request.type === 'init') {
          const payload = request.payload as InitPayload | undefined;
          await sendWorkerRequest('init', {
            options: payload?.options ?? {},
            assets: options.assets,
          });
          send({ type: 'response', id: request.id, success: true });
          continue;
        }

        if (request.type === 'convert') {
          const payload = request.payload as ConvertPayload;
          const result = await sendWorkerRequest('convert', payload) as {
            data: string;
            mimeType: string;
            filename: string;
            duration: number;
          };
          send({
            type: 'response',
            id: request.id,
            success: true,
            data: result,
          });
          continue;
        }

        if (request.type === 'getPageCount') {
          const pageCount = await sendWorkerRequest('getPageCount', request.payload);
          send({ type: 'response', id: request.id, success: true, data: pageCount });
          continue;
        }

        if (request.type === 'destroy') {
          if (worker) {
            await sendWorkerRequest('destroy');
            (worker as Worker).terminate();
            worker = null;
          }
          send({ type: 'response', id: request.id, success: true });
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: 'response', id: request.id, success: false, error: message });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    send({ type: 'error', error: message });
  } finally {
    if (worker) {
      (worker as Worker).terminate();
    }
  }
}

export function getDefaultOutputDirectory(argv: readonly string[] = process.argv, bunMain?: string): string {
  return isCompiledBunExecutable(argv, bunMain) ? './converted-single' : './converted';
}

export function toProgressInfo(message: string, percent: number, phase: ProgressInfo['phase']): ProgressInfo {
  return { message, percent, phase };
}

export const BUN_RESULT_MIME_TYPES = FORMAT_MIME_TYPES;
