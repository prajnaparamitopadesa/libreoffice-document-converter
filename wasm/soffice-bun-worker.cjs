'use strict';
/**
 * Bun Worker Entry Point for soffice.cjs pthreads
 *
 * This wrapper ensures that Emscripten correctly detects the Bun Web Worker
 * context as a pthread worker.
 *
 * Bun 1.3.x differences from the Web Worker spec:
 *  1. `WorkerGlobalScope` is not defined in workers → ENVIRONMENT_IS_WORKER = false
 *  2. `self.name` is undefined even when a name is passed to `new Worker(url, {name})`
 *     → ENVIRONMENT_IS_PTHREAD = false
 *  3. `self.location` is not defined → crash in scriptDirectory setup
 *
 * All three are polyfilled here before requiring soffice.cjs.
 */

// 1. Polyfill WorkerGlobalScope so ENVIRONMENT_IS_WORKER = true
if (typeof WorkerGlobalScope === 'undefined') {
  // `globalThis.constructor` is the global's own class (e.g. Window in browsers).
  // In Bun workers it is typically undefined, so we fall back to a named class
  // which is easier to identify in stack traces.
  const WorkerGlobalScopeClass = globalThis.constructor || class WorkerGlobalScope {};
  Object.defineProperty(globalThis, 'WorkerGlobalScope', {
    value: WorkerGlobalScopeClass,
    writable: true,
    configurable: true,
  });
}

// 2. Force pthread mode: self.name must start with "em-pthread" for
//    ENVIRONMENT_IS_PTHREAD = ENVIRONMENT_IS_WORKER && self.name?.startsWith("em-pthread")
//    to evaluate to true.  Bun 1.3.x does not propagate the Worker constructor's
//    `name` option to self.name, so we set it manually.
if (!globalThis.name || !globalThis.name.startsWith('em-pthread')) {
  globalThis.name = 'em-pthread-bun';
}

// 3. Polyfill self.location (used by Emscripten to set up scriptDirectory).
//    In pthread mode the scriptDirectory value is not used for file loading
//    (the WASM module arrives via postMessage), but the access still runs
//    unconditionally and would crash without this polyfill.
if (!globalThis.location) {
  globalThis.location = { href: 'file://', pathname: '/', hostname: '' };
}

// Load the patched main WASM module.  With the polyfills above, soffice.cjs
// will detect ENVIRONMENT_IS_PTHREAD=true and skip the data-file loading,
// instead waiting for the {cmd:"load"} message from the main thread.
require('./soffice.cjs');
