# Bun Support

This document explains how to use `@matbee/libreoffice-converter` in a
[Bun](https://bun.sh) environment – both as a directly-executed TypeScript
script **and** as a single-file compiled executable.

---

## Quick start

```bash
# Script mode – run the bundled example directly
bun examples/bun-conversion.ts tests/sample_test_1.pptx
# → PNG images are saved to  ./converted/

# Compiled mode – build a self-contained binary, then run it
bun build --compile examples/bun-conversion.ts --outfile bun-conversion
./bun-conversion tests/sample_test_1.pptx
# → PNG images are saved to  ./converted-single/
```

> **Prerequisites**
> - The `wasm/` directory must be present (or set `WASM_PATH`).
> - The `dist/subprocess.worker.cjs` must be present (run `npm run build`, or set `WORKER_PATH`).
> - `node` must be in `PATH` (see [WASM compatibility note](#wasm-compatibility-note) below).

---

## WASM compatibility note

Bun 1.x uses the **JavaScriptCore (JSC)** JavaScript engine.  As of Bun 1.3.11,
JSC does not fully support the WebAssembly feature combination used by the
LibreOffice WASM binary (`SIMD128 + bulk-memory + exception-handling + pthreads`).

As a result, the WASM subprocess is executed via **Node.js** (which uses V8 and
supports all required WASM features).  The Bun script itself still runs in Bun;
only the WASM worker process uses Node.js.

When a future Bun release adds complete WASM compatibility, the
`isBunSubprocess()` branch in the example can be activated to run the worker
directly inside Bun without Node.js.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  entry point (Bun)                                              │
│                                                                 │
│  isBunSubprocess()?                                             │
│    yes → [future: run WASM worker in Bun]                       │
│    no  → runMainMode()                                          │
│            │                                                    │
│            │  spawn('node', ['dist/subprocess.worker.cjs'])     │
│            │  via IPC (child_process.spawn + stdio 'ipc')       │
│            ▼                                                    │
│  ┌──────────────────┐                                           │
│  │ Node.js worker   │  ← dist/subprocess.worker.cjs            │
│  │ • loads WASM     │                                           │
│  │ • renders slides │                                           │
│  │ • returns RGBA   │                                           │
│  └──────────────────┘                                           │
│            │                                                    │
│  encode RGBA → PNG in Bun (zlib is Bun-compatible)             │
│  save PNG files                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### The subprocess detection pattern

The entry-point of `examples/bun-conversion.ts` implements the standard
**subprocess detection** idiom:

```typescript
if (isBunSubprocess()) {
  // Run as WASM worker (for future Bun versions with full WASM support)
  await runWorkerMode();
  process.exit(0);
}

// Run as controller
await runMainMode();
process.exit(0);
```

This pattern is kept so the code is ready for a future Bun version that
supports the full WASM feature set without changes to the interface.

### Script mode vs. compiled mode

Bun's `process.argv` layout is the same in both modes — user args always
start at `argv[2]`:

| | argv[0] | argv[1] | argv[2+] |
|---|---|---|---|
| Script mode | `/path/to/bun` | `/path/to/script.ts` | user args |
| Compiled mode | `"bun"` | `"/$bunfs/root/<binary>"` | user args |

`isCompiledBinary()` detects the mode by checking whether `argv[1]` matches a
script-file extension (`.ts`, `.js`, `.mjs`, etc.).

---

## `@matbee/libreoffice-converter/bun` entry

This library provides a dedicated Bun export:

```typescript
import {
  isBunSubprocess,
  isBunCompiledBinary,
  // plus the full Node.js-compatible API
  LibreOfficeConverter,
  rgbaToPng,
  // …
} from '@matbee/libreoffice-converter/bun';
```

| Export | Description |
|--------|-------------|
| `isBunSubprocess()` | `true` when `BUN_SUBPROCESS_WORKER === '1'` |
| `isBunCompiledBinary()` | `true` when `argv[1]` is not a `.ts/.js` path |

---

## IPC protocol

The Bun main process communicates with the Node.js WASM worker using the
**same IPC message protocol** as the library's built-in `SubprocessConverter`:

```
Main (Bun)                         Worker (node)
────────────────────────────────   ─────────────────────────
                               ◄── { type: 'ready' }
{ type: 'init', id }           ──►
                               ◄── { type: 'response', id, success: true }
{ type: 'getPageCount', id,    ──►
  payload: { inputData, inputFormat } }
                               ◄── { type: 'response', id, data: 13 }
{ type: 'renderPageFullQuality',──►
  id, payload: { ..., pageIndex: 0, dpi: 150 } }
                               ◄── { type: 'response', id,
                                     data: { data: [...rgba], width, height } }
…
{ type: 'destroy', id }        ──►
```

The RGBA data returned by the worker is encoded to PNG in Bun's main process
using the library's `rgbaToPng` helper (Bun supports Node.js `zlib`).

---

## Deploying the compiled binary

```
my-deployment/
├── bun-conversion                 ← compiled binary (Bun)
├── dist/subprocess.worker.cjs     ← Node.js WASM worker
└── wasm/
    ├── loader.cjs
    ├── soffice.wasm               (~110 MB)
    ├── soffice.data               (~80 MB)
    └── …
```

Run from the deployment directory (so relative paths resolve), or set the
environment variables:

```bash
WASM_PATH=/path/to/wasm  WORKER_PATH=/path/to/dist/subprocess.worker.cjs  ./bun-conversion input.pptx
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot find the wasm/ directory` | Not running from repo root | Set `WASM_PATH` |
| `Cannot find dist/subprocess.worker.cjs` | Build not done | Run `npm run build` or set `WORKER_PATH` |
| `node: command not found` | Node.js not in PATH | Install Node.js or set `NODE_BINARY` |
| Bun segfault in subprocess | Bun 1.3.x JSC WASM incompatibility | Expected; the worker uses Node.js instead |
| Very slow first run (~1–3 min) | WASM JIT compilation | Normal; subsequent pages reuse the warm WASM |
