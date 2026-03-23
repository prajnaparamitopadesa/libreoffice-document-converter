# Bun Support

This repository now includes a dedicated Bun entry point: `@matbee/libreoffice-converter/bun`.

## What changed

1. Added `src/bun.ts` and the `./bun` package export.
2. Bun now injects the packaged `wasm/loader.cjs` automatically, so Bun users do not need to wire `wasmLoader` manually.
3. `wasmPath` is forwarded into the loader so the loader resolves `soffice.wasm`, `soffice.data`, and worker assets relative to the caller-selected directory instead of assuming `loader.cjs`'s own directory.
4. The Node worker wrapper and Emscripten worker bootstrap files were adjusted so Bun can resolve the pthread worker bootstrap from the adjacent `soffice.worker.cjs` / `soffice.worker.js` files.
5. Added Bun examples:
   - `examples/bun-conversion.ts` for script mode
   - `examples/bun-build.ts` for Bun single-executable build mode

## Why these changes were needed

Before this change, the Node-oriented API required callers to provide `wasmLoader` themselves. That works in Node-centric setups, but it is awkward in Bun and especially fragile when Bun compiles an entry point into a native executable.

The other issue was path resolution. The WASM loader originally assumed the runtime assets always lived next to `loader.cjs`. That assumption breaks in Bun-oriented packaging flows where the executable or entry script may need to point the library at a different `wasm` directory.

## Technical approach

### 1. Dedicated Bun entry

`src/bun.ts` wraps the existing `LibreOfficeConverter` and applies Bun defaults:

- default `wasmPath: './wasm'`
- default `wasmLoader: require('../wasm/loader.cjs')`

That keeps the public API small and reuses the existing converter implementation.

### 2. Loader path forwarding

`src/converter-node.ts` now passes `wasmPath` into `wasmLoader.createModule(...)`.

`wasm/loader.cjs` now resolves the active WASM directory from `config.wasmPath`, and then uses that directory for:

- `process.chdir(...)` during module bootstrap
- `locateFile(...)`
- `require(...)` of `soffice.cjs`
- Bun worker redirection to `soffice.worker.cjs`

This is the key piece that allows Bun script mode and Bun-compiled executables to point the library at the correct runtime asset directory.

### 3. Bun worker bootstrap compatibility

LibreOffice WASM uses Emscripten pthread workers. Bun's worker bootstrap path is slightly different from Node's, so the worker wrapper now redirects Bun worker creation to `soffice.worker.cjs`, and the worker bootstrap falls back to its sibling `soffice.cjs` / `soffice.js` when no explicit `urlOrBlob` is provided.

## Script mode example

```bash
bun examples/bun-conversion.ts tests/sample_test_1.pptx
```

Outputs PNG files into `./converted`.

## Single executable example

Build the executable:

```bash
bun examples/bun-build.ts
```

Run it:

```bash
./bun-conversion tests/sample_test_1.pptx
```

Outputs PNG files into `./converted-single`.

## Notes

- The examples assume the Bun process is started from the repository root.
- The executable still needs access to the repository's `./wasm` directory at runtime.
- `tests/bun.test.ts` covers the Bun entry point defaults and lifecycle cleanup logic.
