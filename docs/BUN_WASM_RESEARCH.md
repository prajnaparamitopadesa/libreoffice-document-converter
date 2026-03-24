# Bun WASM Compatibility Research

## Summary

This document records comprehensive research into making the LibreOffice WASM converter work natively in Bun (without spawning Node.js subprocesses). The core blocker is an incompatibility between Bun's JavaScriptCore (JSC) WASM runtime and Emscripten's pthread model, specifically around WASM-level `memory.atomic.wait32` cross-thread signaling.

## What Works in Bun

| Feature | Status | Notes |
|---------|--------|-------|
| `require('worker_threads')` | ✅ | Worker, isMainThread, parentPort all available |
| `require('vm')` | ✅ | vm.runInThisContext available (but `class` redeclaration fails) |
| `require('fs')`, `require('path')` | ✅ | Full compatibility |
| `SharedArrayBuffer` | ✅ | Works across workers |
| `Atomics.wait` / `Atomics.notify` (JS) | ✅ | Works on main thread and workers, timeouts work correctly |
| `Atomics.waitAsync` | ✅ | Promise-based async wait works |
| `worker_threads` message passing | ✅ | postMessage/on('message') works |
| `worker.unref()` | ⚠️ | Does not kill worker, but causes premature GC in some cases |
| WASM binary loading (140MB) | ✅ | readFileSync works |
| `require('./soffice.cjs')` (main thread) | ✅ | Emscripten module loads |
| `wasmLoader.createModule()` | ✅ | Module initializes in ~2.3s |
| `module.FS` / `module.ccall` | ✅ | Available after init |
| CJS file workers with keepalive | ✅ | Workers with `setInterval` stay alive |
| Worker → main thread message passing during ccall | ❌ | Main thread blocked in WASM, can't process messages |
| WASM `memory.atomic.wait32` cross-thread signaling | ❌ | **Root cause** - workers notify but main thread doesn't wake |
| `WebAssembly.Instance` in worker via `vm.runInThisContext` | ❌ | `class` redeclaration SyntaxError in JSC |
| Bun native Web Worker for WASM | ❌ | Same WASM threading issues in Web Worker context |

## The Blocker: `libreofficekit_hook` Deadlock

### Symptom
Calling `module.ccall('libreofficekit_hook', ...)` in Bun hangs indefinitely or causes a segfault, while the identical call works in Node.js (~604ms).

### Root Cause: WASM Atomic Cross-Thread Signaling Failure

Through extensive instrumentation, we identified THREE layered issues:

#### Issue 1: Worker Lifecycle (Fixable ✅)
Emscripten pthread workers die in Bun because `parentPort.on("message")` alone doesn't keep the event loop alive. **Fix**: Add `setInterval(() => {}, 30000)` as keepalive.

#### Issue 2: WASM Module Assertion in Workers (Fixable ✅)
When soffice.cjs loads in a worker, the PTHREAD path of `createWasm()` doesn't call `addRunDependency('wasm-instantiate')`, but the "load" message handler calls `wasmModuleReceived()` → `receiveInstance()` → `removeRunDependency('wasm-instantiate')`, causing `runDependencies` to go below 0 and triggering an assertion crash. This only manifests in Bun because of timing differences. **Fix**: Patch `removeRunDependency` to gracefully handle underflow.

#### Issue 3: WASM-Level Thread Synchronization (NOT Fixable via JS ❌)
Even with Issues 1 & 2 fixed (workers alive, WASM instantiated, no crashes):
- Workers correctly receive `{cmd: "run"}` messages
- Workers enter the "run" handler and call WASM thread functions
- The main thread blocks in WASM code (`memory.atomic.wait32`) waiting for thread completion
- Workers execute but their WASM `memory.atomic.notify` does NOT wake the main thread
- **This is a JSC/Bun incompatibility** - V8 (Node.js) handles WASM atomic cross-thread signaling correctly

### Evidence (Detailed)

**Workers are stable with patches** (v8 configuration):
```
[W1]load  [W2]load  [W3]load  [W4]load  ← Workers initialized
[SPAWN]unused=4                           ← spawnThread during module init
module: 2.30s                             ← Module ready
Workers stable                            ← No errors during 5s wait
[SPAWN]unused=3                           ← LOK calls pthread_create
[W3]run                                   ← Worker receives run command
TIMEOUT                                   ← Main thread blocked forever
```

**JS Atomics work perfectly**:
```
Atomics.wait + timeout: ✅ (returns "timed-out" correctly)
Atomics.wait + notify from worker: ✅ (wakes in ~60ms)
Atomics.wait on WASM SharedArrayBuffer: ✅ (timeout works)
```

**Synchronous thread execution (v16) partially works**:
When bypassing workers entirely and calling thread functions synchronously:
```
[BUN-SPAWN] fn=252051
[E] warn:vcl:42:1:vcl/source/app/svmain.cxx:214: no OpenSSL CA certificate bundle found
```
LibreOffice VCL initialization DOES run, proving the WASM code itself works. But the thread function blocks on `memory.atomic.wait32` waiting for a signal from another thread that doesn't exist in synchronous mode.

**Single-threaded mode (v9)** with `spawnThread` returning EAGAIN:
```
[E] warn:sal.osl:42:1:sal/osl/unx/thread.cxx:300: pthread_create failed: EAGAIN
Error: ["std::runtime_error", "osl::Thread::create failed"]
```
LibreOffice REQUIRES at least one thread - single-threaded mode is not viable.

## All Approaches Attempted

### 1. Direct Use ❌
Module init works, LOK init hangs/crashes (workers die).

### 2. Worker Keepalive Patch ❌
Workers stay alive, but LOK still hangs (WASM threading issue).

### 3. Keepalive + Unref Disable + removeRunDependency Fix ❌
Workers fully stable (no errors), LOK still hangs (confirmed WASM-level issue).

### 4. Browser Mode (ENVIRONMENT_IS_WEB) ❌
Path resolution failures, `importScripts` not available in Bun Workers.

### 5. soffice.worker.cjs as Worker Entry ❌
`vm.runInThisContext` causes JSC `class` redeclaration error; `require()` breaks Module scope; `WebAssembly.Instance` LinkError for memory imports.

### 6. Bun Native Web Worker ❌
Same WASM threading deadlock in Web Worker context.

### 7. Single-Threaded Mode (spawnThread → EAGAIN) ❌
LibreOffice throws `osl::Thread::create failed` - requires at least 1 thread.

### 8. Synchronous Thread Execution ❌
Thread function blocks on `memory.atomic.wait32` (deadlock on single thread).

### 9. Async Thread Dispatch (setTimeout) ❌
Main thread blocks in `ccall` before setTimeout fires; event loop never runs.

## soffice.cjs Patches Identified

The following patches are needed to fix JavaScript-level issues in Bun. These alone are NOT sufficient to make LOK work (due to Issue 3), but they resolve Issues 1 & 2:

```javascript
// 1. Worker keepalive (after parentPort.on in PTHREAD section)
parentPort.on("message", function(msg) { onmessage({data:msg}) });
setInterval(function(){}, 30000);

// 2. Disable worker.unref() for Bun (2 locations)
if(ENVIRONMENT_IS_NODE && !worker.pthread_ptr && !process.versions.bun) { worker.unref() }
if(ENVIRONMENT_IS_NODE && !process.versions.bun) { worker.unref() }

// 3. Fix removeRunDependency assertion (PTHREAD workers)
function removeRunDependency(id) {
  runDependencies--;
  if(runDependencies < 0 && process.versions && process.versions.bun) {
    runDependencies = 0; return;
  }
  // ... rest of function
}
```

## Recommended Path Forward

### Option A: Recompile LibreOffice WASM Without Pthreads (Best)
- Compile with `-s USE_PTHREADS=0 -s PROXY_TO_PTHREAD=0`
- Also compile with `-s ALLOW_BLOCKING_ON_MAIN_THREAD=1`
- Eliminates all worker_threads dependencies
- LibreOffice would need internal changes to not require `osl::Thread::create`
- **Most reliable long-term solution**

### Option B: Recompile with PROXY_TO_PTHREAD + Asyncify
- Compile with `-s PROXY_TO_PTHREAD=1 -sASYNCIFY=1`
- Main function runs on a worker thread, JS main thread stays free for proxy calls
- `ccall` with `{async: true}` would return a Promise
- Avoids the main thread blocking issue entirely

### Option C: File Bun Bug Report
- The WASM `memory.atomic.wait32` / `memory.atomic.notify` cross-thread mechanism doesn't work correctly in Bun's JSC
- JS-level `Atomics.wait/notify` works fine, but the WASM instructions don't trigger proper cross-thread wakeup
- This is likely a JavaScriptCore bug or missing feature

## Environment Details
- Bun v1.3.11
- Linux x64 (glibc v2.39), Kernel v6.14.0
- soffice.wasm: 140.6 MB
- soffice.data: 95 MB  
- Emscripten pthread pool size: 4 workers
- Node.js baseline: module init ~648ms, LOK init ~604ms
- Bun module init: ~2.3s (works), LOK init: hangs (WASM threading)
