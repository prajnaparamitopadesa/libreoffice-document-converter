# Bun Runtime Support

This library supports [Bun](https://bun.sh) as a first-class runtime, including the ability to compile your application into a single-file executable with `bun build --compile`.

## Table of Contents

- [Quick Start](#quick-start)
- [Script Mode](#script-mode)
- [Compiled Binary Mode](#compiled-binary-mode)
- [API Reference](#api-reference)
- [Technical Details](#technical-details)
- [Troubleshooting](#troubleshooting)

## Quick Start

### Script Mode (simplest)

```typescript
// convert.ts
import { createSubprocessConverter } from '@matbee/libreoffice-converter/bun';
import { readFile, writeFile } from 'fs/promises';

const converter = await createSubprocessConverter({ wasmPath: './wasm' });
const pptxData = await readFile('slides.pptx');

const result = await converter.convert(pptxData, {
  outputFormat: 'pdf',
  inputFormat: 'pptx',
});

await writeFile('slides.pdf', result.data);
await converter.destroy();
process.exit(0);
```

```bash
bun run convert.ts
```

### Compiled Binary Mode

```typescript
// main.ts
import {
  isBunSubprocess,
  runBunSubprocess,
  BunSubprocessConverter,
} from '@matbee/libreoffice-converter/bun';

// ⚠️ Must be at the very top, before any other logic
if (isBunSubprocess()) {
  await runBunSubprocess();
}

// Main application
const converter = new BunSubprocessConverter({ wasmPath: './wasm' });
await converter.initialize();
// ... use converter ...
await converter.destroy();
process.exit(0);
```

```bash
bun build --compile main.ts --outfile converter
./converter
```

## Script Mode

In script mode (`bun run script.ts`), the library works the same as in Node.js. Bun provides comprehensive Node.js API compatibility, so the existing `SubprocessConverter` and `LibreOfficeConverter` classes work out of the box.

### Which converter to use?

| Class | Use Case |
|-------|----------|
| `SubprocessConverter` | Production servers, long-running processes. Runs WASM in a separate process for clean lifecycle. |
| `LibreOfficeConverter` | Simple one-shot scripts. Runs WASM in the main thread. Call `process.exit()` after. |
| `BunSubprocessConverter` | Same as `SubprocessConverter`, but also works in compiled binaries. |

### Example: Converting PPT to Images

```typescript
import {
  createSubprocessConverter,
  rgbaToPng,
} from '@matbee/libreoffice-converter/bun';
import { readFile, writeFile } from 'fs/promises';

const converter = await createSubprocessConverter({ wasmPath: './wasm' });
const pptxData = await readFile('presentation.pptx');

// Get slide count
const pageCount = await converter.getPageCount(pptxData, {
  inputFormat: 'pptx',
});

// Render all slides
const previews = await converter.renderPagePreviews(
  pptxData,
  { inputFormat: 'pptx' },
  { width: 1920, pageIndices: Array.from({ length: pageCount }, (_, i) => i) },
);

// Save as PNG
for (const preview of previews) {
  const pngData = await rgbaToPng(preview.data, preview.width, preview.height);
  await writeFile(`slide-${preview.page}.png`, pngData);
}

await converter.destroy();
process.exit(0);
```

## Compiled Binary Mode

Bun can compile TypeScript/JavaScript applications into standalone executables with `bun build --compile`. This creates a single binary that includes the Bun runtime and your bundled application code.

### The Challenge

The LibreOffice WASM converter uses subprocess isolation: the heavy WASM module runs in a separate child process, communicating via IPC. In Node.js, this child process runs a separate `.cjs` worker script file.

When compiled into a single binary, there are no separate script files on disk. The compiled binary must be able to act as both:
1. The **main application** (parent process)
2. The **subprocess worker** (child process handling WASM operations)

### The Solution: Self-Spawning Pattern

The `BunSubprocessConverter` implements a self-spawning pattern:

1. The parent process spawns `process.execPath` (the compiled binary itself) with a special `--libreoffice-subprocess` flag
2. The entry point detects this flag using `isBunSubprocess()`
3. If the flag is present, `runBunSubprocess()` enters the IPC message loop
4. If not, normal application logic runs

```
┌─────────────────────┐     spawn(self, --libreoffice-subprocess)     ┌─────────────────────┐
│   Main Process      │ ─────────────────────────────────────────────▶│  Subprocess Worker  │
│                     │                                               │                     │
│  BunSubprocess-     │◀──────── IPC messages (convert, render) ─────▶│  LibreOffice WASM   │
│  Converter          │                                               │  (Emscripten)       │
└─────────────────────┘                                               └─────────────────────┘
```

### Entry Point Pattern

The subprocess check **must** be at the very top of your entry point, before any other application logic:

```typescript
import { isBunSubprocess, runBunSubprocess } from '@matbee/libreoffice-converter/bun';

// ⚠️ This MUST be the first thing that runs
if (isBunSubprocess()) {
  await runBunSubprocess();
  // This function never returns
}

// Your application code below...
```

### Building

```bash
# Compile to a standalone executable
bun build --compile main.ts --outfile ppt-converter

# Run it (WASM files must be accessible on disk)
./ppt-converter --wasm-path ./wasm input.pptx
```

> **Note:** The `wasm/` directory (containing `soffice.wasm`, `soffice.data`, `loader.cjs`, etc.) must be available on the filesystem at runtime. These files are ~240MB and cannot be embedded in the compiled binary.

### Full Example

See [`examples/bun-compiled/main.ts`](../examples/bun-compiled/main.ts) for a complete working example.

## API Reference

### `isBunSubprocess(): boolean`

Check if the current process was spawned as a LibreOffice subprocess worker. Returns `true` if `--libreoffice-subprocess` is in `process.argv`.

### `runBunSubprocess(): Promise<never>`

Enter subprocess worker mode. This function:
1. Sets up polyfills (XMLHttpRequest, Worker) required by Emscripten
2. Loads the WASM module from the path specified in `WASM_PATH` env var
3. Enters an IPC message loop handling conversion requests
4. **Never returns** - the process exits when the parent sends a 'destroy' message

### `BunSubprocessConverter`

A subprocess-based converter that works in both script and compiled binary modes.

```typescript
const converter = new BunSubprocessConverter({
  wasmPath: './wasm',      // Path to the wasm/ directory
  verbose: false,          // Enable debug logging
  maxInitRetries: 3,       // Retry initialization on failure
  maxConversionRetries: 2, // Retry conversions on memory errors
  restartOnMemoryError: true, // Auto-restart subprocess on WASM memory errors
});

await converter.initialize();
```

**Mode detection:** The converter automatically detects whether it's running in script mode or compiled binary mode by checking if the subprocess worker script exists on disk. No manual configuration needed.

**Methods** (same as `SubprocessConverter`):
- `convert(input, options, filename?)` — Convert a document
- `getPageCount(input, options)` — Get page/slide count
- `getDocumentInfo(input, options)` — Get document metadata
- `renderPage(input, options, pageIndex, width, height?)` — Render a single page to RGBA
- `renderPagePreviews(input, options, renderOptions?)` — Render multiple pages
- `renderPageFullQuality(input, options, pageIndex, renderOptions?)` — High-DPI rendering
- `getDocumentText(input, inputFormat)` — Extract text content
- `getPageNames(input, inputFormat)` — Get page/slide names
- `openDocument(input, options)` — Open for editing (editor API)
- `editorOperation(sessionId, method, args?)` — Execute editor command
- `closeDocument(sessionId)` — Close editor session
- `destroy()` — Clean up and terminate subprocess

### `createBunSubprocessConverter(options?): Promise<BunSubprocessConverter>`

Convenience function that creates and initializes a `BunSubprocessConverter`.

### Re-exports

The `@matbee/libreoffice-converter/bun` entry point also re-exports commonly needed utilities:

- `LibreOfficeConverter` — Direct WASM converter (for simple scripts)
- `SubprocessConverter` / `createSubprocessConverter` — Node.js-compatible subprocess converter
- `rgbaToPng` / `rgbaToJpeg` / `rgbaToWebp` / `encodeImage` — Image encoding utilities
- `loadFontsFromDirectory` / `loadSystemFonts` / etc. — Font loading utilities
- `ConversionError` / `ConversionErrorCode` — Error types
- All relevant TypeScript types

## Technical Details

### Why a Separate Entry Point?

The `@matbee/libreoffice-converter/bun` entry point exists because:

1. **Bundling for compiled binaries:** The `runBunSubprocess()` function needs `LibreOfficeConverter`, `createEditor`, and other modules bundled inline (not as external imports) so they're available inside the compiled binary without filesystem access.

2. **Subprocess detection:** The `isBunSubprocess()` and `runBunSubprocess()` functions provide the self-spawning pattern needed for compiled binaries.

3. **Clean API:** Users import from a single entry point without worrying about internal module structure.

### WASM Loading Flow

```
1. BunSubprocessConverter.initialize()
   ├── Detect mode (script vs compiled)
   ├── Spawn subprocess:
   │   ├── Script mode:   fork('dist/subprocess.worker.cjs')
   │   └── Compiled mode: spawn(process.execPath, ['--libreoffice-subprocess'])
   └── Send 'init' message via IPC

2. Subprocess worker (runBunSubprocess or subprocess.worker.cjs):
   ├── Set up polyfills (XMLHttpRequest, Worker)
   ├── process.chdir(wasmDir)  — required for Emscripten data loading
   ├── Load wasm/loader.cjs    — WASM module loader
   ├── Create LibreOfficeConverter with wasmLoader
   ├── Initialize WASM (~3-10 seconds)
   └── Enter IPC message loop

3. Conversion request:
   Parent: converter.convert(data, opts)
   └── IPC → Subprocess: handleConvert(payload)
       ├── Write input to Emscripten virtual FS
       ├── LOK documentLoad()
       ├── LOK documentSaveAs()
       ├── Read output from virtual FS
       └── IPC → Parent: result data
```

### Emscripten Polyfills

The LibreOffice WASM module is compiled with Emscripten, which expects a browser-like environment. The subprocess worker sets up:

- **`XMLHttpRequest`**: Emscripten uses XHR to load the `.data` filesystem image. The polyfill redirects to synchronous `fs.readFileSync()`.
- **`Worker`**: Emscripten uses Web Workers for pthread support. The polyfill maps to Node.js `worker_threads.Worker`.
- **`process.chdir(wasmDir)`**: Emscripten resolves file paths relative to CWD, so we temporarily change to the WASM directory.

### Process Isolation Benefits

Using subprocess isolation (instead of running WASM in the main thread) provides:

1. **Clean process exit**: WASM pthread workers keep the Node.js/Bun process alive indefinitely. With subprocess isolation, killing the child process cleanly terminates all threads.
2. **Memory isolation**: The ~200MB WASM memory is in a separate process and fully released on cleanup.
3. **Error recovery**: If the WASM module crashes (memory errors, corruption), the subprocess can be restarted without affecting the main application.
4. **Non-blocking**: Heavy WASM operations don't block the main event loop.

## Troubleshooting

### "WASM directory not found"

The `wasm/` directory must be accessible at runtime. When using a compiled binary, specify it with `--wasm-path`:

```bash
./my-converter --wasm-path /path/to/wasm input.pptx
```

Or set `wasmPath` in the converter options:

```typescript
const converter = new BunSubprocessConverter({
  wasmPath: '/absolute/path/to/wasm',
});
```

### Process doesn't exit after conversion

If using `LibreOfficeConverter` directly (not `SubprocessConverter` or `BunSubprocessConverter`), WASM pthread workers keep the process alive. Call `process.exit(0)` after your work is done, or use the subprocess converter.

### Compiled binary can't find modules

When compiling with `bun build --compile`, make sure your imports are from `@matbee/libreoffice-converter/bun` (not `/server` or the main entry). The `/bun` entry bundles all necessary code for compiled binary support.

### IPC communication errors

If you see "Subprocess start timeout" errors, check:
1. The WASM directory path is correct and accessible
2. The `wasm/soffice.wasm` and `wasm/soffice.data` files exist (they're ~240MB total, managed via Git LFS)
3. Sufficient memory is available (~200MB for the WASM module)
