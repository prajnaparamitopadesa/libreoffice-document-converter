# Bun WASM Compatibility Research

## Summary

This document records research into making the LibreOffice WASM converter work natively in Bun (without spawning Node.js subprocesses). The core blocker is a Bun incompatibility with Emscripten's pthread worker model.

## What Works in Bun

| Feature | Status | Notes |
|---------|--------|-------|
| `require('worker_threads')` | ✅ | Worker, isMainThread, parentPort all available |
| `require('vm')` | ✅ | vm.runInThisContext available |
| `require('fs')`, `require('path')` | ✅ | Full compatibility |
| `SharedArrayBuffer` | ✅ | Works across workers |
| `Atomics.wait` / `Atomics.notify` | ✅ | Works on main thread and workers |
| `Atomics.waitAsync` | ✅ | Promise-based async wait works |
| `worker_threads` message passing | ✅ | postMessage/on('message') works |
| `receiveMessageOnPort` | ✅ | Synchronous message receive works |
| `worker.unref()` | ✅ | Does not kill worker |
| WASM binary loading (140MB) | ✅ | readFileSync works |
| `require('./soffice.cjs')` (main thread) | ✅ | Emscripten module loads |
| `wasmLoader.createModule()` | ✅ | Module initializes in ~2.3s |
| `module.FS` / `module.ccall` | ✅ | Available after init |
| CJS workers via eval mode | ✅ | `new Worker(code, {eval:true})` stays alive |
| CJS file workers with keepalive | ✅ | Workers with `setInterval` stay alive |
| MessagePort transfer between workers | ❌ | "Unable to deserialize data" error |

## The Blocker: `libreofficekit_hook` Deadlock

### Symptom
Calling `module.ccall('libreofficekit_hook', ...)` in Bun hangs indefinitely or causes a segfault, while the identical call works in Node.js (~627ms).

### Root Cause Analysis

The Emscripten-compiled LibreOffice uses **pthreads** (mapped to `worker_threads` Workers). When `libreofficekit_hook` is called:

1. The C code internally calls `pthread_create` → Emscripten's `spawnThread()`
2. `spawnThread` sends a `{cmd: "run"}` message to an available worker
3. The worker should execute the thread function
4. The main thread blocks via `Atomics.wait()` for the result
5. **The workers die before processing the "run" command** → deadlock

### Why Workers Die in Bun

Emscripten creates pthread workers via:
```javascript
worker = new Worker(_scriptName, {workerData: "em-pthread"});
// _scriptName = __filename = path to soffice.cjs
```

In **Node.js**: After `soffice.cjs` loads in the worker, `parentPort.on("message", ...)` counts as an active handle, keeping the worker alive indefinitely.

In **Bun**: The worker exits with code 0 after the CJS file finishes executing. The `parentPort.on("message")` listener alone does NOT keep Bun's worker event loop alive for directly-loaded CJS files. This is a Bun-specific behavior difference.

### Evidence
- Bun crash reports consistently show `workers_spawned(4) workers_terminated(4)` — all 4 pthread workers die
- Without the keepalive patch: segfault at address 0x0 (null pointer from dead worker)
- With keepalive patch (`setInterval` in worker code): no crash, but still hangs

### The Deeper Issue

Even after patching soffice.cjs to add `setInterval(() => {}, 60000)` after `parentPort.on("message")`, the LOK init still hangs. This suggests a **second issue** beyond worker lifecycle:

The Emscripten pthread proxy mechanism (`_emscripten_receive_on_main_thread_js`) may not function correctly in Bun. When a worker thread needs the main thread to execute a function (proxy call), it uses a mailbox system with `Atomics.waitAsync` + `checkMailbox`. If the main thread is blocked in a synchronous `ccall`, the event loop can't process these proxy callbacks.

In Node.js, this works because of Node's internal handling of `Atomics.wait` that can interleave with message processing. Bun may not have this same capability.

## Approaches Attempted

### 1. Direct Use of Existing Loader ❌
- `loader.cjs` + `soffice.cjs` in Node.js mode
- Module init works, LOK init hangs/crashes

### 2. Patched soffice.cjs with Worker Keepalive ❌  
- Added `setInterval(()=>{},60000)` after `parentPort.on("message")`
- Workers stay alive (no crash), but LOK init still hangs
- Suggests proxy mechanism issue, not just lifecycle

### 3. Browser Mode (ENVIRONMENT_IS_WEB) ❌
- Set `window = globalThis`, hide `process.versions.node`
- Emscripten tries to use native Web Workers instead of worker_threads
- Workers can't load soffice.cjs properly in browser Worker context

### 4. mainScriptUrlOrBlob with Wrapper ❌
- Created wrapper CJS that `require()`s soffice.cjs
- Module init works, LOK init still hangs

### 5. Running Everything in a Worker Thread ❌
- Moved WASM loading + LOK init into a worker_threads Worker
- Same crash: Emscripten's sub-workers still die

## Recommended Path Forward

### Option A: Recompile LibreOffice WASM Without Pthreads
- Compile with `-s USE_PTHREADS=0` (single-threaded mode)
- This eliminates all worker_threads dependencies
- Trade-off: slower performance, but full Bun compatibility
- **Most reliable solution**

### Option B: Wait for Bun Fix
- File a Bun bug report about worker_threads CJS worker lifecycle
- File a Bun bug report about Emscripten pthread proxy compatibility
- Track Bun's Node.js compatibility improvements

### Option C: Use Bun's Native Worker API
- Bun has its own `Worker` class (Web Worker compatible)
- Would require significant patches to soffice.cjs to use Bun Workers instead of worker_threads
- Complex but potentially viable

### Option D: Subprocess with Bun (Not Node)
- Use `Bun.spawn(["bun", "worker-script.ts"])` instead of `child_process.fork()`
- The subprocess is a separate Bun process with its own event loop
- Avoids the threading issues by isolating WASM in a subprocess
- **Note**: Same pthread issues would exist in the subprocess

## Environment Details
- Bun v1.3.11
- Linux x64 (glibc v2.39)
- soffice.wasm: 140.6 MB
- soffice.data: 95 MB
- Emscripten pthread pool size: 4 workers
