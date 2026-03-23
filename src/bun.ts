/**
 * Bun Runtime Support for LibreOffice WASM Document Converter
 *
 * This module provides first-class Bun support, including the ability to run
 * inside a `bun build --compile` single-file executable.
 *
 * ## Script Mode
 *
 * When running via `bun run script.ts`, the library works out of the box.
 * The subprocess worker script is forked as a separate process, just like Node.js.
 *
 * ## Compiled Binary Mode
 *
 * When the application is compiled with `bun build --compile`, there is no
 * separate worker script file on disk. Instead, the compiled binary re-executes
 * itself with a special `--libreoffice-subprocess` flag. The entry point must
 * detect this flag and call `runBunSubprocess()` to enter worker mode.
 *
 * ```typescript
 * import { isBunSubprocess, runBunSubprocess, BunSubprocessConverter } from '@matbee/libreoffice-converter/bun';
 *
 * // Must be checked before any other application logic
 * if (isBunSubprocess()) {
 *   await runBunSubprocess();
 *   // This function never returns
 * }
 *
 * // Main application logic
 * const converter = new BunSubprocessConverter({ wasmPath: './wasm' });
 * await converter.initialize();
 * const result = await converter.convert(pptxBuffer, {
 *   outputFormat: 'pdf',
 *   inputFormat: 'pptx',
 * });
 * ```
 *
 * @packageDocumentation
 */

export {
  BunSubprocessConverter,
  createBunSubprocessConverter,
  BUN_SUBPROCESS_FLAG,
} from './bun.subprocess-converter.js';
export type { BunSubprocessConverterOptions } from './bun.subprocess-converter.js';

// Re-export the standard converter for script mode (works with Bun as-is)
export { LibreOfficeConverter } from './converter-node.js';
export { SubprocessConverter, createSubprocessConverter } from './subprocess.worker-converter.js';

// Re-export types and utilities commonly needed
export type {
  ConversionOptions,
  ConversionResult,
  FontData,
  ImageOptions,
  InputFormat,
  LibreOfficeWasmOptions,
  OutputFormat,
  PdfOptions,
  ProgressInfo,
} from './types.js';

export {
  ConversionError,
  ConversionErrorCode,
  FORMAT_FILTERS,
  FORMAT_MIME_TYPES,
  EXTENSION_TO_FORMAT,
  getValidOutputFormats,
  isConversionValid,
  getConversionErrorMessage,
} from './types.js';

// Re-export image utilities
export {
  encodeImage,
  rgbaToPng,
  rgbaToJpeg,
  rgbaToWebp,
  isSharpAvailable,
  getSharp,
} from './image-utils.js';
export type { ImageEncodeOptions } from './image-utils.js';

// Re-export font loaders
export {
  loadFontsFromZip,
  loadFontsFromDirectory,
  loadSystemFonts,
  loadFontsFromPackage,
  loadFontsFromPackages,
} from './font-loader.js';

import { BUN_SUBPROCESS_FLAG } from './bun.subprocess-converter.js';

/**
 * Check if the current process was spawned as a LibreOffice subprocess worker.
 *
 * Call this at the very beginning of your compiled binary's entry point.
 * If it returns `true`, call `runBunSubprocess()` immediately.
 *
 * @returns `true` if the process was invoked with the `--libreoffice-subprocess` flag.
 *
 * @example
 * ```typescript
 * if (isBunSubprocess()) {
 *   await runBunSubprocess();
 * }
 * ```
 */
export function isBunSubprocess(): boolean {
  return process.argv.includes(BUN_SUBPROCESS_FLAG);
}

/**
 * Enter subprocess worker mode for compiled Bun binaries.
 *
 * This function:
 * 1. Sets up polyfills required by the Emscripten WASM module
 * 2. Loads and initializes the LibreOffice WASM converter
 * 3. Enters a message loop handling IPC requests from the parent process
 *
 * **This function never returns.** The process exits when the parent sends
 * a 'destroy' message or when the parent process terminates.
 *
 * The WASM directory path is read from the `WASM_PATH` environment variable
 * (set automatically by `BunSubprocessConverter`).
 *
 * @example
 * ```typescript
 * import { isBunSubprocess, runBunSubprocess } from '@matbee/libreoffice-converter/bun';
 *
 * if (isBunSubprocess()) {
 *   await runBunSubprocess();
 *   // Never reaches here
 * }
 * ```
 */
export async function runBunSubprocess(): Promise<never> {
  const path = await import('path');
  const fs = await import('fs');

  const wasmPath = process.env.WASM_PATH || './wasm';
  const verbose = process.env.VERBOSE === 'true';
  const wasmDir = path.isAbsolute(wasmPath) ? wasmPath : path.resolve(wasmPath);

  function log(...args: unknown[]) {
    if (verbose) console.error('[BunSubprocess]', ...args);
  }

  // Verify wasm directory
  if (!fs.existsSync(wasmDir)) {
    const error = `WASM directory not found: ${wasmDir}\n  WASM_PATH: ${wasmPath}\n  CWD: ${process.cwd()}`;
    console.error('[BunSubprocess]', error);
    process.send?.({ type: 'error', error });
    process.exit(1);
  }

  // Change to wasm directory for Emscripten's data file loading
  process.chdir(wasmDir);

  // XMLHttpRequest polyfill required by Emscripten's data loader
  class NodeXHR {
    readyState = 0;
    status = 0;
    responseType = '';
    response: unknown = null;
    responseText = '';
    onload: (() => void) | null = null;
    onerror: ((err: Error) => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    private _url = '';

    open(_method: string, url: string) { this._url = url; this.readyState = 1; }
    overrideMimeType() { /* no-op */ }
    setRequestHeader() { /* no-op */ }

    send() {
      try {
        const data = fs.readFileSync(this._url);
        this.status = 200;
        this.readyState = 4;
        if (this.responseType === 'arraybuffer') {
          this.response = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
          this.responseText = data.toString('utf8');
          this.response = this.responseText;
        }
        if (this.onload) this.onload();
        if (this.onreadystatechange) this.onreadystatechange();
      } catch (err) {
        this.status = 404;
        this.readyState = 4;
        if (this.onerror) this.onerror(err as Error);
      }
    }
  }

  // Set up global polyfills
  (globalThis as Record<string, unknown>).XMLHttpRequest = NodeXHR;

  // Import Worker from worker_threads for Emscripten pthread support
  const { Worker } = await import('worker_threads');
  (globalThis as Record<string, unknown>).Worker = Worker;

  // Dynamically load the WASM loader from the wasm directory
  const { createRequire } = await import('module');
  const dynamicRequire = createRequire(path.join(wasmDir, '_bun_entry.js'));

  let wasmLoader: { createModule: (config: Record<string, unknown>) => Promise<unknown> };
  try {
    wasmLoader = dynamicRequire('./loader.cjs');
  } catch (e) {
    const error = `Failed to load WASM loader from ${wasmDir}: ${(e as Error).message}`;
    console.error('[BunSubprocess]', error);
    process.send?.({ type: 'error', error });
    process.exit(1);
  }

  // Import the converter and editor (these are bundled in the compiled binary)
  const { LibreOfficeConverter } = await import('./converter-node.js');
  const { createEditor } = await import('./editor/index.js');
  const { buildLoadOptions } = await import('./types.js');

  // Converter state
  let converter: InstanceType<typeof LibreOfficeConverter> | null = null;

  // Editor session tracking
  interface EditorSessionState {
    sessionId: string;
    docPtr: number;
    filePath: string;
    editor: ReturnType<typeof createEditor>;
    documentType: string;
  }

  const editorSessions = new Map<string, EditorSessionState>();
  let sessionCounter = 0;

  // ─── Handlers ────────────────────────────────────────────

  async function handleInit(payload?: { fonts?: { filename: string; data: number[] }[]; includeSystemFonts?: boolean }): Promise<void> {
    if (converter?.isReady()) return;

    const fonts = payload?.fonts?.map(f => ({
      filename: f.filename,
      data: new Uint8Array(f.data),
    }));

    log('Creating LibreOfficeConverter...');
    converter = new LibreOfficeConverter({
      wasmPath: wasmDir,
      verbose,
      wasmLoader: wasmLoader as never,
      fonts,
      includeSystemFonts: payload?.includeSystemFonts,
    });

    log('Initializing converter...');
    await converter.initialize();
    log('Converter initialized successfully');
  }

  async function handleConvert(payload: { inputData: number[]; inputExt: string; outputFormat: string; filterOptions: string }): Promise<number[]> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    const inputData = new Uint8Array(payload.inputData);
    const result = await converter.convert(inputData, {
      inputFormat: payload.inputExt,
      outputFormat: payload.outputFormat,
    } as never, 'document');
    return Array.from(result.data);
  }

  async function handleGetPageCount(payload: { inputData: number[]; inputFormat: string }): Promise<number> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    return converter.getPageCount(new Uint8Array(payload.inputData), { inputFormat: payload.inputFormat, outputFormat: 'pdf' } as never);
  }

  async function handleGetDocumentInfo(payload: { inputData: number[]; inputFormat: string }): Promise<unknown> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    return converter.getDocumentInfo(new Uint8Array(payload.inputData), { inputFormat: payload.inputFormat, outputFormat: 'pdf' } as never);
  }

  async function handleRenderPage(payload: { inputData: number[]; inputFormat: string; pageIndex: number; width: number; height?: number }): Promise<{ data: number[]; width: number; height: number }> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    const previews = await converter.renderPagePreviews(
      new Uint8Array(payload.inputData),
      { inputFormat: payload.inputFormat } as never,
      { width: payload.width, height: payload.height || 0, pageIndices: [payload.pageIndex] },
    );
    if (previews.length === 0) throw new Error(`Page ${payload.pageIndex} not found`);
    const p = previews[0]!;
    return { data: Array.from(p.data), width: p.width, height: p.height };
  }

  async function handleRenderPagePreviews(payload: { inputData: number[]; inputFormat: string; width: number; height?: number; pageIndices?: number[] }): Promise<Array<{ page: number; data: number[]; width: number; height: number }>> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    const previews = await converter.renderPagePreviews(
      new Uint8Array(payload.inputData),
      { inputFormat: payload.inputFormat } as never,
      { width: payload.width, height: payload.height || 0, pageIndices: payload.pageIndices },
    );
    return previews.map((p: { page: number; data: Uint8Array; width: number; height: number }) => ({
      page: p.page, data: Array.from(p.data), width: p.width, height: p.height,
    }));
  }

  async function handleRenderPageFullQuality(payload: { inputData: number[]; inputFormat: string; pageIndex: number; dpi: number; maxDimension?: number; editMode?: boolean }): Promise<{ page: number; data: number[]; width: number; height: number; dpi: number }> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    const p = await converter.renderPageFullQuality(
      new Uint8Array(payload.inputData),
      { inputFormat: payload.inputFormat } as never,
      payload.pageIndex,
      { dpi: payload.dpi, maxDimension: payload.maxDimension, editMode: payload.editMode ?? false },
    );
    return { page: p.page, data: Array.from(p.data), width: p.width, height: p.height, dpi: p.dpi };
  }

  async function handleGetDocumentText(payload: { inputData: number[]; inputFormat: string }): Promise<string | null> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    return converter.getDocumentText(new Uint8Array(payload.inputData), { inputFormat: payload.inputFormat, outputFormat: 'pdf' } as never);
  }

  async function handleGetPageNames(payload: { inputData: number[]; inputFormat: string }): Promise<string[]> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    return converter.getPageNames(new Uint8Array(payload.inputData), { inputFormat: payload.inputFormat, outputFormat: 'pdf' } as never);
  }

  async function handleOpenDocument(payload: { inputData: number[]; inputFormat: string }): Promise<{ sessionId: string; documentType: string; pageCount: number }> {
    if (!converter?.isReady()) throw new Error('Worker not initialized');
    const lokBindings = converter.getLokBindings();
    const module = converter.getModule();
    if (!lokBindings || !module) throw new Error('LOK bindings not available');

    const sessionId = `session_${++sessionCounter}_${Date.now()}`;
    const filePath = `/tmp/edit_${sessionId}.${payload.inputFormat}`;

    module.FS.writeFile(filePath, new Uint8Array(payload.inputData));

    const loadOptions = buildLoadOptions(payload.inputFormat);
    const docPtr = loadOptions
      ? lokBindings.documentLoadWithOptions(filePath, loadOptions)
      : lokBindings.documentLoad(filePath);

    if (docPtr === 0) {
      const error = lokBindings.getError();
      module.FS.unlink(filePath);
      throw new Error(`Failed to load document: ${String(error)}`);
    }

    lokBindings.documentInitializeForRendering(docPtr);
    const viewId = lokBindings.createView(docPtr);
    lokBindings.setView(docPtr, viewId);
    lokBindings.registerCallback(docPtr);
    lokBindings.postUnoCommand(docPtr, '.uno:Edit');

    const editor = createEditor(lokBindings, docPtr);
    const documentType = editor.getDocumentType();
    const pageCount = lokBindings.documentGetParts(docPtr);

    editorSessions.set(sessionId, { sessionId, docPtr, filePath, editor, documentType });
    return { sessionId, documentType, pageCount };
  }

  async function handleEditorOperation(payload: { sessionId: string; method: string; args?: unknown[] }): Promise<unknown> {
    const session = editorSessions.get(payload.sessionId);
    if (!session) throw new Error(`Session not found: ${payload.sessionId}`);

    const method = (session.editor as unknown as Record<string, unknown>)[payload.method];
    if (typeof method !== 'function') throw new Error(`Unknown editor method: ${payload.method}`);

    const result = (method as (...args: unknown[]) => { success: boolean; verified?: boolean; data?: unknown; error?: string; suggestion?: string })
      .apply(session.editor, payload.args || []);

    let serializedData = result.data;
    if (result.data instanceof Map) {
      serializedData = Object.fromEntries(result.data as Map<unknown, unknown>);
    }

    return { success: result.success, verified: result.verified, data: serializedData, error: result.error, suggestion: result.suggestion };
  }

  async function handleCloseDocument(payload: { sessionId: string }): Promise<number[] | undefined> {
    const session = editorSessions.get(payload.sessionId);
    if (!session) throw new Error(`Session not found: ${payload.sessionId}`);

    const lokBindings = converter?.getLokBindings();
    const module = converter?.getModule();
    let modifiedData: number[] | undefined;

    if (module && lokBindings) {
      try {
        const ext = session.filePath.split('.').pop() || 'docx';
        lokBindings.documentSaveAs(session.docPtr, session.filePath, ext, '');
        const data = module.FS.readFile(session.filePath) as Uint8Array;
        modifiedData = Array.from(data);
      } catch (e) {
        console.warn('[BunSubprocess] Could not save document:', e);
      }
    }

    if (lokBindings && session.docPtr !== 0) {
      try { lokBindings.unregisterCallback(session.docPtr); } catch { /* ignore */ }
      try { lokBindings.documentDestroy(session.docPtr); } catch { /* ignore */ }
    }
    if (module) {
      try { module.FS.unlink(session.filePath); } catch { /* ignore */ }
    }

    editorSessions.delete(payload.sessionId);
    return modifiedData;
  }

  async function handleDestroy(): Promise<void> {
    for (const [, session] of editorSessions) {
      try {
        const lokBindings = converter?.getLokBindings();
        const module = converter?.getModule();
        if (lokBindings && session.docPtr !== 0) {
          try { lokBindings.unregisterCallback(session.docPtr); } catch { /* ignore */ }
          try { lokBindings.documentDestroy(session.docPtr); } catch { /* ignore */ }
        }
        if (module) {
          try { module.FS.unlink(session.filePath); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    editorSessions.clear();

    if (converter) {
      await converter.destroy();
      converter = null;
    }

    log('Destroy complete, exiting process');
    setImmediate(() => process.exit(0));
  }

  // ─── IPC Message Loop ────────────────────────────────────

  process.on('message', async (msg: { type: string; id: string; payload?: unknown }) => {
    try {
      let result: unknown;
      switch (msg.type) {
        case 'init':      await handleInit(msg.payload as never); break;
        case 'convert':   result = await handleConvert(msg.payload as never); break;
        case 'getPageCount':       result = await handleGetPageCount(msg.payload as never); break;
        case 'getDocumentInfo':    result = await handleGetDocumentInfo(msg.payload as never); break;
        case 'renderPage':         result = await handleRenderPage(msg.payload as never); break;
        case 'renderPagePreviews': result = await handleRenderPagePreviews(msg.payload as never); break;
        case 'renderPageFullQuality': result = await handleRenderPageFullQuality(msg.payload as never); break;
        case 'getDocumentText':    result = await handleGetDocumentText(msg.payload as never); break;
        case 'getPageNames':       result = await handleGetPageNames(msg.payload as never); break;
        case 'openDocument':       result = await handleOpenDocument(msg.payload as never); break;
        case 'editorOperation':    result = await handleEditorOperation(msg.payload as never); break;
        case 'closeDocument':      result = await handleCloseDocument(msg.payload as never); break;
        case 'destroy':            await handleDestroy(); break;
        default: throw new Error(`Unknown message type: ${msg.type}`);
      }
      process.send?.({ type: 'response', id: msg.id, success: true, data: result });
    } catch (err) {
      log('Error:', (err as Error).message);
      process.send?.({ type: 'response', id: msg.id, success: false, error: (err as Error).message });
    }
  });

  log('Subprocess worker started, waiting for init...');
  process.send?.({ type: 'ready' });

  // Keep process alive
  setInterval(() => { /* keep alive */ }, 60000);

  // Never returns
  return new Promise<never>(() => { /* infinite wait */ });
}
