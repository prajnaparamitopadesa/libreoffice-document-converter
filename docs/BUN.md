# Bun support

This document explains what was added for Bun support, why the implementation looks the way it does, and how to use the library in both Bun script mode and Bun compiled executable mode.

## What changed

1. **Runtime detection is now Bun-aware**
   - `convertDocument()` previously treated every runtime with `process.versions.node` as regular Node.js.
   - Bun also exposes `process.versions.node`, so it was incorrectly routed to the Node-only `SubprocessConverter` path.
   - The runtime detection now checks `process.versions.bun` explicitly, so Bun uses the direct converter path instead of `child_process.fork()`.

2. **`wasmPath` is now passed all the way into the loader**
   - `wasm/loader.cjs` used to resolve `soffice.wasm`, `soffice.data`, and related files strictly from its own `__dirname`.
   - That works when the package is executed from its installed package directory, but it is too rigid for Bun `--compile`.
   - `LibreOfficeConverter` now forwards `wasmPath` into the loader, and the loader uses that directory when resolving WASM assets.

3. **WASM asset files are now exported in `package.json`**
   - The package now exports `./wasm/soffice.*` entrypoints.
   - This allows Bun applications to import those files with `with { type: "file" }` so Bun can emit them alongside a compiled executable.

4. **Bun self-spawn helpers were added**
   - New helpers such as `getBunSelfSpawnCommand()` and `isBunSubprocessEntrypoint()` make it easier to write a Bun entrypoint that can act as either:
     - the main CLI process, or
     - a subprocess/worker mode selected by a command-line flag.

## Why this design

### Bun is not just “plain Node.js”

Bun is highly compatible with Node.js APIs, but this library's optimized Node.js path assumes:

- `child_process.fork()`
- separate worker/subprocess script files on disk
- static asset lookup relative to the package directory

Those assumptions are not always safe in Bun, especially once the application is compiled with `bun build --compile`.

### Bun compiled executables need explicit asset control

LibreOffice WASM requires several files at runtime:

- `soffice.wasm`
- `soffice.data`
- `soffice.data.js.metadata`
- pthread worker helper files

If the loader always resolves assets from its own `__dirname`, a Bun compiled executable cannot cleanly redirect that lookup to the files Bun emitted for the executable. Passing `wasmPath` through the loader is the smallest general-purpose fix.

### Re-launching the same entrypoint is the most reliable compiled-mode pattern

For a Bun compiled executable, the most portable way to support subprocess-style isolation is:

1. start the main entrypoint normally;
2. inspect command-line arguments;
3. if a special flag is present, run the subprocess/worker branch;
4. otherwise run the normal CLI branch;
5. when isolation is needed, spawn the same executable again with that special flag.

That is exactly what `examples/bun-single-file-ppt-to-images.ts` demonstrates.

## Script mode example

See:

- `examples/bun-ppt-to-images.ts`

Run it with:

```bash
bun examples/bun-ppt-to-images.ts tests/sample_test_1.pptx ./output
```

This example:

- runs directly in Bun;
- imports `wasmLoader` explicitly;
- passes `wasmPath` explicitly;
- converts every slide in a PPT/PPTX file into PNG images.

## Compiled executable example

See:

- `examples/bun-single-file-ppt-to-images.ts`

Build it with:

```bash
bun build --compile examples/bun-single-file-ppt-to-images.ts \
  --outfile dist/bun-ppt-to-images \
  --asset-naming='[name].[ext]'
```

Run it with:

```bash
./dist/bun-ppt-to-images tests/sample_test_1.pptx ./output
```

This example depends on two key ideas:

1. **Use `import ... with { type: "file" }`** so Bun emits the required WASM assets next to the executable.
2. **Use a subprocess flag** so the same entrypoint can switch between main-process mode and subprocess mode.

## Technical summary

### Runtime selection

- **Node.js**: `convertDocument()` still prefers `SubprocessConverter`
- **Bun**: `convertDocument()` now prefers the direct converter path

That prevents Bun from accidentally entering the Node-only fork-based implementation.

### Asset resolution

- `LibreOfficeConverter` now passes `wasmPath` into `wasmLoader.createModule()`
- `wasm/loader.cjs` now resolves `soffice.*` assets relative to that `wasmPath`

That means:

- in script mode, you can point at the package's normal `wasm/` directory;
- in Bun compiled mode, you can point at the asset directory Bun emitted for the executable.

### Single-entrypoint subprocess dispatch

The new Bun helpers let a Bun entrypoint decide:

- whether it is running on Bun;
- whether it was launched in subprocess mode;
- how to construct the correct “spawn myself again” command for either:
  - `bun run script.ts`, or
  - a compiled Bun executable.

This is the implementation behind the “detect subprocess/worker mode at the entrypoint via CLI arguments” approach described in the issue.
