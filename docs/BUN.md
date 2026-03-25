# Bun Support

This document explains how to use `@matbee/libreoffice-converter` in [Bun](https://bun.sh) without Node.js.

---

## Quick Start

```ts
import { LibreOfficeConverter } from '@matbee/libreoffice-converter';
import * as wasmLoader from '@matbee/libreoffice-converter/wasm/loader.cjs';
import { readFile, writeFile } from 'fs/promises';

const converter = new LibreOfficeConverter({
  wasmPath: './node_modules/@matbee/libreoffice-converter/wasm',
  wasmLoader,
});

await converter.initialize();

const input = await readFile('presentation.pptx');
const result = await converter.convert(new Uint8Array(input), {
  outputFormat: 'png',
  image: { pageIndex: 0, dpi: 150 },
});

await writeFile('slide-1.png', result.data);
await converter.destroy();
```

See `examples/bun-conversion.ts` for a full command-line example.

---

## How It Works

### The Problem

Emscripten compiles LibreOffice with `-pthread` support.  When running on
Node.js, Emscripten's generated JavaScript uses `require("worker_threads")`
to spawn pthreads.  Bun provides a partial `worker_threads` compatibility
shim, but the specific way Emscripten transfers `WebAssembly.Module` and
`WebAssembly.Memory` (shared) objects across worker-thread boundaries is not
fully supported in Bun's shim.

### The Solution — Browser Web Worker Path

Bun natively implements the **Web Worker API** (`new Worker(url, {name})`,
`postMessage`, `onmessage`, `WorkerGlobalScope`, …).  Emscripten also has a
browser code path that uses this standard API instead of `worker_threads`.

We activate this path in Bun by making two minimal changes:

#### 1. `wasm/soffice.cjs` patch

A one-character change adds `&&!process.versions.bun` to Emscripten's
`ENVIRONMENT_IS_NODE` variable:

```diff
- var ENVIRONMENT_IS_NODE = … && typeof process.versions.node == "string" && process.type != "renderer";
+ var ENVIRONMENT_IS_NODE = … && typeof process.versions.node == "string" && !process.versions.bun && process.type != "renderer";
```

This prevents soffice.cjs from entering the Node.js branch (and the
`require("worker_threads")` call) when running in Bun.

#### 2. `wasm/loader.cjs` additions

`loader.cjs` detects Bun via `process.versions.bun` and:

| Action | Purpose |
|---|---|
| `global.window = globalThis` | Sets `ENVIRONMENT_IS_WEB = true` in the main thread so Emscripten uses the browser code path |
| Skips `global.Worker = NodeWorker` | Uses Bun's native `Worker` global instead of the Node.js wrapper |
| Skips sync `fs.readFile` polyfill | Bun's async `fs.readFile` works correctly with Emscripten's run-dependency mechanism |
| `Module.mainScriptUrlOrBlob = "…/soffice-bun-worker.cjs"` | Tells Emscripten which script to load in each pthread Web Worker |
| Skips `process.chdir()` | Bun always uses absolute paths via `locateFile` |

#### 3. `wasm/soffice-bun-worker.cjs`

A wrapper that provides three polyfills required by Bun 1.3.x before loading `soffice.cjs`:

| Polyfill | Reason |
|---|---|
| `globalThis.WorkerGlobalScope = class WorkerGlobalScope {}` | Bun 1.3.x does not expose `WorkerGlobalScope` in workers → `ENVIRONMENT_IS_WORKER = false` without this |
| `globalThis.name = "em-pthread-bun"` | Bun 1.3.x does not propagate the `name` option from `new Worker(url, {name})` to `self.name` → `ENVIRONMENT_IS_PTHREAD = false` without this |
| `globalThis.location = { href: "file://", pathname: "/" }` | Bun 1.3.x workers don't have `self.location` (used by Emscripten to compute `scriptDirectory`) → crash without this |

When a pthread worker starts with these polyfills:

```
ENVIRONMENT_IS_NODE   = false  (Bun excluded by soffice.cjs patch)
ENVIRONMENT_IS_WORKER = true   (WorkerGlobalScope polyfilled)
ENVIRONMENT_IS_PTHREAD = true  (self.name = "em-pthread-bun")
```

This is the browser-pthread code path.  Workers receive the
pre-compiled `WebAssembly.Module` and shared `WebAssembly.Memory` from the
main thread via `postMessage` — no file I/O needed in workers.

**Note on Bun's `postMessage` with WebAssembly objects:** Bun 1.3.x supports
passing `WebAssembly.Module` and `WebAssembly.Memory` objects through
`postMessage` as long as no explicit transfer list is provided (i.e., just
`worker.postMessage({ wasmModule, wasmMemory })`, not
`worker.postMessage({...}, [wasmMemory.buffer])`).  Emscripten's
`loadWasmModuleToWorker` already uses this form, so it works without patching.

#### 4. `loader.cjs` main thread additions

`loader.cjs` also provides two additional mocks for the main thread's browser environment:

| Mock | Reason |
|---|---|
| `global.window.location = { pathname: '/', ... }` | Emscripten's `loadPackage` reads `window.location.pathname` unconditionally to compute `PACKAGE_PATH` (even though `Module.locateFile` takes precedence) |
| `global.document = { currentScript: null }` | Prevents crashes in Emscripten's browser environment initialization |

---

## Script Mode Example

Convert a PPTX to PNG images:

```sh
bun examples/bun-conversion.ts tests/sample_test_1.pptx
# → ./converted/sample_test_1-slide-001.png …
```

---

## Single-File Executable Mode

Compile the script to a self-contained binary:

```sh
bun build --compile examples/bun-conversion.ts --outfile bun-conversion
./bun-conversion tests/sample_test_1.pptx
# → ./converted-single/sample_test_1-slide-001.png …
```

> **Note:** The `wasm/` directory must be present next to the compiled binary
> at runtime since it contains the large `.wasm` and `.data` files which cannot
> be bundled into the executable.  Copy `node_modules/@matbee/libreoffice-converter/wasm/`
> to the same directory as the binary before distributing.

---

## Why Not Spawn Node.js?

The previous approach spawned Node.js as a subprocess from Bun.  This:
- Required Node.js to be installed alongside Bun
- Added process-spawn latency for every conversion
- Made single-file executables impractical

The native WASM approach runs everything inside the same Bun process with no
external dependencies beyond the `.wasm` and `.data` files.
