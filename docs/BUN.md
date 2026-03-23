# Bun Support for LibreOffice Document Converter

## What was done

Added Bun runtime support for the LibreOffice WASM document converter, enabling:
1. **Script mode**: `bun examples/bun-conversion.ts tests/sample_test_1.pptx` → images in `./converted/`
2. **Compiled single-file executable**: `bun build --compile --outfile bun-conversion examples/bun-conversion.ts` then `./bun-conversion tests/sample_test_1.pptx` → images in `./converted-single/`

### Files created
- `src/bun.ts` — Bun entry point (`@matbee/libreoffice-converter/bun` export)
- `src/bun.subprocess-converter.ts` — `BunSubprocessConverter` class
- `examples/bun-conversion.ts` — Example for both script and compiled modes
- `docs/BUN.md` — This documentation

### Files modified
- `package.json` — Added `./bun` export path and `typesVersions` entry
- `tsup.config.ts` — Added `bun` to the main build entries
- `.gitignore` — Exclude compiled binary artifact

## Why this architecture

### The Emscripten WASM + Bun JSC incompatibility

The LibreOffice WASM module is compiled with Emscripten and uses pthreads (WebAssembly threads via `SharedArrayBuffer` + `Atomics`). When the `_libreofficekit_hook()` C++ function is called in Bun's JavaScriptCore (JSC) engine, it triggers a **segmentation fault** (null pointer dereference at address 0x0). This is a Bun runtime bug — the same code runs perfectly in Node.js's V8 engine.

Since the WASM module itself cannot be modified, the correct architectural solution is:

- **Main process**: Bun (user application code, fast startup, native TypeScript)
- **Subprocess**: Node.js (WASM processing, proven V8/Emscripten compatibility)
- **Communication**: IPC via `child_process.fork()` with `execPath` set to Node.js

This reuses the existing `subprocess.worker.cjs` and IPC protocol from the Node.js `SubprocessConverter`, ensuring full feature parity.

### Why not a workaround?

1. **Not a polyfill issue**: The segfault occurs in the WASM execution engine itself, not in missing APIs
2. **Not a threading issue**: Even without Worker polyfills, the same crash occurs
3. **Node.js subprocess is architecturally correct**: The library already uses subprocesses for clean process lifecycle (avoiding hanging pthread workers). Delegating to Node.js follows the same proven pattern.
4. **Transparent to users**: The `BunSubprocessConverter` API is identical to the Node.js `SubprocessConverter`

## Technical details

### BunSubprocessConverter

The `BunSubprocessConverter` class:
1. Auto-detects Node.js on the system (`which node` or common paths)
2. Forks a Node.js process running `dist/subprocess.worker.cjs`
3. Communicates via IPC (same protocol as `SubprocessConverter`)
4. Supports retry logic for WASM memory errors
5. Resolves the worker script from multiple candidate paths (handles both development, installed package, and compiled binary scenarios)

### Compiled executable detection

In a compiled Bun binary, `Bun.main` starts with `/$bunfs/` (Bun's virtual filesystem). This is used to detect compiled mode and adjust:
- Output directory (`./converted-single` vs `./converted`)
- WASM path resolution (CWD-relative vs script-relative)
- Worker script resolution (checks `dist/` relative to CWD and executable)

### Requirements

- **Bun** >= 1.0 (tested with 1.3.11)
- **Node.js** >= 18 (used for WASM subprocess)
- The `wasm/` directory with LibreOffice WASM files must be accessible on the filesystem
- The `dist/subprocess.worker.cjs` file must be accessible (from the npm package or build output)

## Usage

### Script mode
```bash
bun examples/bun-conversion.ts tests/sample_test_1.pptx
```

### Compiled single-file executable
```bash
bun build --compile --outfile bun-conversion examples/bun-conversion.ts
./bun-conversion tests/sample_test_1.pptx
```

### Programmatic API
```typescript
import { BunSubprocessConverter } from '@matbee/libreoffice-converter/bun';

const converter = new BunSubprocessConverter({ wasmPath: './wasm' });
await converter.initialize();

const result = await converter.convert(pptxBuffer, {
  outputFormat: 'pdf',
  inputFormat: 'pptx',
});

await converter.destroy();
```
