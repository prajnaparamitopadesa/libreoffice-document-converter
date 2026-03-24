'use strict';
/**
 * Bun Worker Entry Point for soffice.cjs pthreads
 *
 * This wrapper ensures that Emscripten correctly detects the Bun Web Worker
 * context. Some Bun versions may not expose `WorkerGlobalScope` globally even
 * though `self` and `postMessage` are available, so we polyfill it here if
 * necessary before loading the main WASM module.
 *
 * When soffice.cjs runs inside this worker it will see:
 *   ENVIRONMENT_IS_NODE   = false  (Bun excluded by the soffice.cjs patch)
 *   ENVIRONMENT_IS_WORKER = true   (WorkerGlobalScope is defined)
 *   ENVIRONMENT_IS_PTHREAD = true  (self.name starts with "em-pthread")
 *
 * This is the correct browser-worker path that works with Bun's native
 * Web Worker implementation.
 */

// Ensure Emscripten detects this as a Web Worker context.
// In standard Bun Web Workers `WorkerGlobalScope` is already defined, but
// older Bun releases or edge-cases may omit it.
if (typeof WorkerGlobalScope === 'undefined') {
  // Provide a minimal WorkerGlobalScope so the ENVIRONMENT_IS_WORKER check
  // in soffice.cjs evaluates to true.
  Object.defineProperty(globalThis, 'WorkerGlobalScope', {
    value: globalThis.constructor || class WorkerGlobalScope {},
    writable: true,
    configurable: true,
  });
}

// Load the patched main WASM module.  The Bun-patched soffice.cjs will now
// detect ENVIRONMENT_IS_WORKER=true and run in pthread mode.
require('./soffice.cjs');
