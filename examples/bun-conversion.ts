/**
 * Example: Bun PPTX → PNG Conversion
 *
 * Converts every slide of a PPTX (or any supported document) to PNG images
 * using the LibreOffice WASM converter running natively inside Bun.
 *
 * The WASM module is loaded directly in the current Bun process — no Node.js
 * subprocess is spawned.  Bun's native Web Worker API is used for Emscripten's
 * pthread thread pool.
 *
 * Script mode (run directly with Bun):
 *   bun examples/bun-conversion.ts tests/sample_test_1.pptx
 *   → images saved to ./converted/
 *
 * Single-file executable mode (after `bun build --compile`):
 *   ./bun-conversion tests/sample_test_1.pptx
 *   → images saved to ./converted-single/
 *
 * How it works
 * ------------
 * 1. `wasm/loader.cjs` detects Bun via `process.versions.bun`.
 * 2. It sets `global.window = globalThis` so Emscripten's `soffice.cjs` enters
 *    the *browser* code path (ENVIRONMENT_IS_WEB=true) instead of the Node.js
 *    worker_threads path that is incompatible with Bun.
 * 3. soffice.cjs has been patched with `&&!process.versions.bun` on its
 *    ENVIRONMENT_IS_NODE check, so Bun is never mistaken for Node.js.
 * 4. pthread workers are spawned via Bun's native `Worker` global.  Each worker
 *    loads `wasm/soffice-bun-worker.cjs` which polyfills `WorkerGlobalScope`
 *    if necessary and then loads `soffice.cjs` in ENVIRONMENT_IS_PTHREAD mode.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wasmLoader = require('../wasm/loader.cjs') as Record<string, unknown>;

import { LibreOfficeConverter } from '../src/converter-node.js';
import type { WasmLoaderModule, InputFormat } from '../src/types.js';
import { readFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Portable __dirname for both script and compiled mode
const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// ------------------------------------------------------------------
// Detect compiled single-file executable mode.
// When compiled with `bun build --compile`, the script is embedded in a
// standalone executable.  In that mode, wasm/ must sit next to the binary.
// ------------------------------------------------------------------
function getWasmDir(): string {
  const candidates = [
    join(__dir, '..', 'wasm'),           // script mode: examples/../wasm
    join(dirname(process.execPath), 'wasm'), // compiled mode: exe-dir/wasm
    resolve('./wasm'),                       // cwd fallback
  ];
  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (existsSync(abs)) return abs;
  }
  return resolve('./wasm');
}

// Determine output directory: "converted-single" for compiled executables,
// "converted" for script mode.
function getOutputDir(): string {
  // The compiled binary's execPath does NOT end with 'bun' or 'bun.exe'.
  const execBase = basename(process.execPath);
  const isCompiled = execBase !== 'bun' && execBase !== 'bun.exe';
  return isCompiled ? './converted-single' : './converted';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: bun examples/bun-conversion.ts <input-file>');
    console.log('');
    console.log('Example:');
    console.log('  bun examples/bun-conversion.ts tests/sample_test_1.pptx');
    process.exit(1);
  }

  const inputPath = args[0];
  const wasmPath = getWasmDir();
  const outputDir = getOutputDir();

  console.log('🐇 LibreOffice WASM Converter – Bun native');
  console.log('');
  console.log(`   Input:    ${inputPath}`);
  console.log(`   WASM dir: ${wasmPath}`);
  console.log(`   Output:   ${outputDir}/`);
  console.log('');

  if (!existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Read input file
  const inputData = await readFile(inputPath);
  const inputName = basename(inputPath, extname(inputPath));
  const inputExt = extname(inputPath).slice(1) || 'pptx';

  // Initialise the converter using the Bun-compatible loader.
  // The loader detects Bun automatically (process.versions.bun) and routes
  // Emscripten through the browser Web Worker code path.
  console.log('⚙️  Initialising LibreOffice WASM (Bun native mode)...');

  const converter = new LibreOfficeConverter({
    wasmPath,
    wasmLoader: wasmLoader as unknown as WasmLoaderModule,
    verbose: false,
    onProgress: (p) => {
      process.stdout.write(`\r   ${p.phase}: ${p.percent}%  ${p.message}   `);
    },
  });

  await converter.initialize();
  console.log('\n✅ LibreOffice initialised');

  // Discover the page count via getDocumentInfo
  let pageCount = 1;
  try {
    const info = await converter.getDocumentInfo(
      new Uint8Array(inputData),
    { inputFormat: inputExt as InputFormat },
    );
    pageCount = info.pageCount ?? 1;
  } catch {
    // Best-effort; default to exporting page 0 only
  }

  console.log(`📄 Slides/pages: ${pageCount}`);
  console.log('🖼️  Exporting as PNG...');

  const startTime = Date.now();
  const exported: string[] = [];

  for (let i = 0; i < pageCount; i++) {
    const result = await converter.convert(
      new Uint8Array(inputData),
      {
        outputFormat: 'png',
        image: { pageIndex: i, dpi: 150 },
      },
      `${inputName}.${inputExt}`,
    );

    const filename = `${inputName}-slide-${String(i + 1).padStart(3, '0')}.png`;
    const outPath = join(outputDir, filename);
    await writeFile(outPath, result.data);
    exported.push(outPath);
    process.stdout.write(`\r   exported ${i + 1}/${pageCount}: ${filename}   `);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n✅ Done in ${duration}s — ${exported.length} image(s) saved to ${outputDir}/`,
  );

  await converter.destroy();
}

main().catch((err: unknown) => {
  console.error('❌', err);
  process.exit(1);
});
