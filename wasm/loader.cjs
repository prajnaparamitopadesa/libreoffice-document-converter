/**
 * WASM Loader for LibreOffice – Node.js and Bun
 *
 * This CommonJS wrapper provides the necessary polyfills and setup
 * for loading the Emscripten-generated LibreOffice WASM module in Node.js
 * and in Bun (via Bun's native Web Worker API).
 *
 * Bun support notes
 * -----------------
 * Bun identifies itself through `process.versions.bun`.  Emscripten's
 * generated code uses `worker_threads` for pthreads on Node.js, but Bun's
 * `worker_threads` implementation is not fully compatible with Emscripten's
 * pthread model (shared WASM module/memory transfer).  Instead we route Bun
 * through Emscripten's *browser* Web Worker code path which Bun natively
 * supports via its `Worker` global.
 *
 * Key changes when running in Bun:
 *  1. `soffice.cjs` has been patched: `&&!process.versions.bun` added to
 *     `ENVIRONMENT_IS_NODE` so Bun is treated as a browser environment.
 *  2. `global.window = globalThis` is set so `ENVIRONMENT_IS_WEB = true`.
 *  3. Bun's native `Worker` global is used (not overridden with NodeWorker).
 *  4. `Module.mainScriptUrlOrBlob` points to `soffice-bun-worker.cjs` so
 *     pthread worker threads load with the correct environment setup.
 *  5. The synchronous `fs.readFile` polyfill is not applied for Bun because
 *     Emscripten's run-dependency mechanism handles async file reads fine,
 *     and blocking the event loop would be harmful in Bun.
 *
 * Load Time Optimizations:
 * - Pre-loads WASM binary before module init
 * - Uses synchronous file I/O (required for Emscripten on Node.js)
 * - Supports pre-compiled WASM modules for faster startup
 * - Can cache compiled modules for reuse
 */

'use strict';

const fs = require('fs');
const path = require('path');

const wasmDir = __dirname;

// Detect Bun runtime – present as of Bun 1.0+
const isBun = typeof process !== 'undefined' && !!process.versions.bun;

if (isBun) {
  // In Bun we use the browser Web Worker path in soffice.cjs.
  // Setting global.window makes ENVIRONMENT_IS_WEB=true so Emscripten
  // does not try to use Node.js worker_threads for pthreads.
  global.window = globalThis;

  // Emscripten's data-file loader computes PACKAGE_PATH from
  // window.location.pathname.  We only need it as a fallback (Module.locateFile
  // takes precedence), but the access still runs unconditionally and would
  // crash with "undefined is not an object".  Provide a minimal mock.
  if (!global.window.location) {
    global.window.location = { pathname: '/', href: 'file://', hostname: '' };
  }

  // Emscripten's browser environment check also guards against
  // "not compiled for this environment" with a check on `document`.
  // Provide a minimal stub so optional chaining on `document.currentScript`
  // doesn't throw on older code patterns.
  if (typeof global.document === 'undefined') {
    global.document = { currentScript: null };
  }
} else {
  // Node.js: provide a Worker wrapper that resolves relative paths into
  // the WASM directory (soffice.cjs spawns workers using its own filename).
  const { Worker: NodeWorker } = require('worker_threads');

  class Worker extends NodeWorker {
    constructor(filename, options) {
      let resolvedPath = filename;
      if (!path.isAbsolute(filename)) {
        resolvedPath = path.join(wasmDir, path.basename(filename));
      }
      super(resolvedPath, options);
    }
  }

  // Make Worker globally available so soffice.cjs picks it up before it
  // overwrites global.Worker with the raw worker_threads.Worker.
  global.Worker = Worker;
}

// Cache for compiled WASM module (reuse across instances)
let cachedWasmModule = null;
let cachedWasmBinary = null;

// Change to wasm directory for relative path resolution (if supported).
// Not needed in Bun because we always use absolute paths via locateFile.
// Not available in Node.js worker threads.
const origCwd = process.cwd();
let changedDir = false;
if (!isBun) {
  try {
    process.chdir(wasmDir);
    changedDir = true;
  } catch (err) {
    // In worker threads, chdir is not supported – use absolute paths instead.
    if (err.code !== 'ERR_WORKER_UNSUPPORTED_OPERATION') {
      throw err;
    }
  }
}

// File sizes for progress calculation (approximate)
const FILE_SIZES = {
  'soffice.wasm': 116000000,  // ~110MB
  'soffice.data': 84000000,   // ~80MB
};

let currentProgressCallback = null;
let lastProgress = 0;

// Helper to ensure monotonic progress
function emitProgress(phase, percent, message) {
  if (currentProgressCallback) {
    // Ensure progress only goes up
    const adjustedPercent = Math.max(lastProgress, percent);
    lastProgress = adjustedPercent;
    currentProgressCallback(phase, adjustedPercent, message);
  }
}

// Make fs.readFile synchronous for Node.js (required because WASM init blocks
// the event loop on that platform).  Bun does not need this: its Emscripten
// code path (browser/Web Worker) uses Emscripten's async run-dependency
// mechanism which works fine with Bun's native async fs.readFile.
const origReadFile = fs.readFile.bind(fs);
if (!isBun) {
  fs.readFile = function(filePath, optionsOrCallback, maybeCallback) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    
    const filename = path.basename(filePath);
    
    // Emit progress for large files
    if (filename === 'soffice.data') {
      emitProgress('loading_data', 20, 'Loading LibreOffice data files...');
    }
    
    try {
      const data = fs.readFileSync(filePath, options);
      
      if (filename === 'soffice.data') {
        emitProgress('loading_data', 35, `Loaded ${(data.length / 1024 / 1024).toFixed(0)}MB filesystem image`);
      }
      
      callback(null, data);
    } catch (err) {
      callback(err);
    }
  };
}

// XMLHttpRequest polyfill for Node.js with progress
class NodeXMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseType = '';
    this.response = null;
    this.responseText = '';
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onprogress = null;
    this._url = '';
  }

  open(method, url) {
    this._url = url;
    this.readyState = 1;
  }

  overrideMimeType() {}
  setRequestHeader() {}

  send() {
    const filename = path.basename(this._url);
    
    try {
      // Emit progress before loading large files
      if (filename === 'soffice.data') {
        emitProgress('loading_data', 20, 'Loading LibreOffice filesystem image...');
      } else if (filename.endsWith('.metadata')) {
        emitProgress('loading_metadata', 15, 'Loading filesystem metadata...');
      }
      
      const data = fs.readFileSync(this._url);
      this.status = 200;
      this.statusText = 'OK';
      this.readyState = 4;

      if (this.responseType === 'arraybuffer') {
        this.response = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        this.responseText = data.toString('utf8');
        this.response = this.responseText;
      }

      // Emit progress after loading
      if (filename === 'soffice.data') {
        emitProgress('loading_data', 38, `Loaded ${(data.length / 1024 / 1024).toFixed(0)}MB filesystem`);
      }

      // onreadystatechange is what Emscripten uses
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
    } catch (err) {
      this.status = 404;
      this.statusText = 'Not Found';
      this.readyState = 4;
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onerror) this.onerror(err);
    }
  }
}

global.XMLHttpRequest = NodeXMLHttpRequest;

/**
 * Create and initialize the LibreOffice WASM module
 * 
 * @param {Object} config - Configuration options
 * @param {Function} config.onProgress - Progress callback (phase, percent, message)
 * @returns {Promise<Object>} - The initialized Emscripten module
 */
function createModule(config = {}) {
  return new Promise((resolve, reject) => {
    // Reset progress tracking
    lastProgress = 0;
    currentProgressCallback = config.onProgress || null;
    
    // Emit initial progress
    emitProgress('starting', 0, 'Starting LibreOffice WASM...');
    
    // Use cached binary if available, otherwise load
    let wasmBinary = config.wasmBinary;
    if (!wasmBinary) {
      if (cachedWasmBinary) {
        emitProgress('loading_wasm', 12, 'Using cached WebAssembly binary');
        wasmBinary = cachedWasmBinary;
      } else {
        emitProgress('loading_wasm', 2, 'Loading WebAssembly binary...');
        
        const wasmPath = path.join(wasmDir, 'soffice.wasm');
        const wasmData = fs.readFileSync(wasmPath);
        wasmBinary = wasmData.buffer.slice(wasmData.byteOffset, wasmData.byteOffset + wasmData.byteLength);
        
        // Cache for future use
        cachedWasmBinary = wasmBinary;
        
        emitProgress('loading_wasm', 12, `Loaded ${(wasmData.length / 1024 / 1024).toFixed(0)}MB WebAssembly binary`);
      }
    }
    
    emitProgress('compiling', 14, 'Compiling WebAssembly module...');
    
    // Set up the Module configuration
    global.Module = {
      wasmBinary,
      
      // Pass environment variables to WASM (for SAL_LOK_OPTIONS, LOK_SKIP_PRELOAD, etc.)
      // Note: ENV is set up by Emscripten's preRun, our preRun runs after
      preRun: [],
      
      // Locate files using absolute paths
      locateFile: (filename) => {
        const resolved = path.join(wasmDir, filename);
        if (config.verbose) {
          console.log('[WASM] locateFile:', filename, '->', resolved);
        }
        return resolved;
      },

      // Bun: tell Emscripten which script to load in pthread worker threads.
      // In browser mode (used for Bun) _scriptName is undefined, so we must
      // provide mainScriptUrlOrBlob explicitly.  We use the Bun worker wrapper
      // that polyfills WorkerGlobalScope when necessary.
      mainScriptUrlOrBlob: isBun ? path.join(wasmDir, 'soffice-bun-worker.cjs') : undefined,
      
      // Runtime initialized callback
      onRuntimeInitialized: () => {
        emitProgress('runtime_ready', 45, 'WebAssembly runtime initialized');
        
        if (config.verbose) {
          console.log('[WASM] Runtime initialized');
        }
        
        // Restore original cwd if we changed it
        if (changedDir) {
          process.chdir(origCwd);
        }
        
        // Clear progress callback (but keep cache)
        currentProgressCallback = null;
        
        // Call user's callback if provided
        if (config.onRuntimeInitialized) {
          config.onRuntimeInitialized();
        }
        
        resolve(global.Module);
      },
      
      // Output handlers
      print: config.print || (() => {}),
      printErr: config.printErr || (() => {}),
      
      // Copy any additional config (except functions we've handled)
      ...Object.fromEntries(
        Object.entries(config).filter(([k]) => 
          !['onProgress', 'onRuntimeInitialized', 'print', 'printErr', 'verbose', 'wasmBinary'].includes(k)
        )
      ),
    };

    try {
      // Load the soffice module
      // This is a patched version that uses global.Module
      require('./soffice.cjs');
    } catch (err) {
      if (changedDir) {
        process.chdir(origCwd);
      }
      currentProgressCallback = null;
      reject(err);
    }
  });
}

/**
 * Synchronous module initialization
 * Returns a Module object that will be populated when ready
 */
function createModuleSync(config = {}) {
  global.Module = {
    wasmBinary: config.wasmBinary,
    locateFile: (filename) => path.join(wasmDir, filename),
    onRuntimeInitialized: config.onRuntimeInitialized || (() => {}),
    print: config.print || (() => {}),
    printErr: config.printErr || (() => {}),
    ...config,
  };

  require('./soffice.cjs');
  
  return global.Module;
}

/**
 * Pre-load the WASM binary into memory (call early for faster init later)
 * This allows you to start loading while doing other work.
 * 
 * @returns {Buffer} The WASM binary
 */
function preloadWasmBinary() {
  if (cachedWasmBinary) {
    return cachedWasmBinary;
  }
  
  const wasmPath = path.join(wasmDir, 'soffice.wasm');
  const wasmData = fs.readFileSync(wasmPath);
  cachedWasmBinary = wasmData.buffer.slice(wasmData.byteOffset, wasmData.byteOffset + wasmData.byteLength);
  return cachedWasmBinary;
}

/**
 * Pre-compile the WASM module (if WebAssembly.compile is available)
 * This can be done during idle time for faster startup.
 * 
 * @returns {Promise<WebAssembly.Module>} The compiled module
 */
async function precompileWasm() {
  if (cachedWasmModule) {
    return cachedWasmModule;
  }
  
  const binary = preloadWasmBinary();
  cachedWasmModule = await WebAssembly.compile(binary);
  return cachedWasmModule;
}

/**
 * Check if WASM binary is already cached
 */
function isCached() {
  return !!cachedWasmBinary;
}

/**
 * Clear cached data (for memory cleanup)
 */
function clearCache() {
  cachedWasmBinary = null;
  cachedWasmModule = null;
}

/**
 * Get file sizes for progress estimation
 */
function getFileSizes() {
  const wasmPath = path.join(wasmDir, 'soffice.wasm');
  const dataPath = path.join(wasmDir, 'soffice.data');
  
  return {
    wasm: fs.existsSync(wasmPath) ? fs.statSync(wasmPath).size : 0,
    data: fs.existsSync(dataPath) ? fs.statSync(dataPath).size : 0,
    get total() { return this.wasm + this.data; },
  };
}

module.exports = {
  createModule,
  createModuleSync,
  preloadWasmBinary,
  precompileWasm,
  isCached,
  clearCache,
  getFileSizes,
  wasmDir,
};
