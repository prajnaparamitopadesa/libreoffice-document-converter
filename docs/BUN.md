# Bun support

This repository now supports running LibreOffice WASM conversions in a pure Bun runtime without spawning `node`.

## What changed

- Added a Bun entry point at `src/bun.ts` / package export `@matbee/libreoffice-converter/bun`
- Added a Bun-compatible WASM bootstrap at `wasm/soffice.bun.bootstrap.js`
- Updated `src/browser.worker.ts` so Bun workers can load the Emscripten runtime even though Bun workers do not provide `importScripts()`
- Added a Bun example at `examples/bun-conversion.ts`

## Why this approach

The generated LibreOffice WASM runtime already works well in web-worker style environments, but Bun workers differ from browsers in one important detail: classic workers do not expose `importScripts()`. The previous Node-oriented paths also depended on subprocesses / worker threads, which is not the right model for a pure Bun flow.

Instead of shelling out to Node, Bun now uses the existing worker-based WASM path and supplies a tiny bootstrap script that:

1. loads `soffice.js` from disk,
2. evaluates it with Node globals hidden so Emscripten takes the worker/web path instead of the Node path,
3. provides a Bun-side `importScripts()` equivalent for any follow-up worker bootstrapping.

## Script mode

From the repository root:

```bash
bun examples/bun-conversion.ts tests/sample_test_1.pptx
```

Output images are written to:

```text
./converted
```

## Single executable mode

Compile the same example with Bun:

```bash
bun build --compile examples/bun-conversion.ts --outfile bun-conversion
```

Then run it from the repository root:

```bash
./bun-conversion tests/sample_test_1.pptx
```

Output images are written to:

```text
./converted-single
```

## Technical notes

- The Bun example intentionally points at `./src/browser.worker.ts` and `./wasm` from the repository root so the same code path works in both script mode and compiled-executable mode.
- No Node subprocesses are used.
- The Bun path uses the worker/browser conversion implementation, which keeps the runtime aligned with Bun's Web Worker model.
