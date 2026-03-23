/**
 * Bun Compiled Binary Example - PPT to Images
 *
 * Demonstrates using the LibreOffice WASM converter as a standalone
 * single-file executable compiled with `bun build --compile`.
 *
 * ## Build
 *
 *   bun build --compile examples/bun-compiled/main.ts --outfile ppt-to-images
 *
 * ## Run
 *
 *   ./ppt-to-images --wasm-path ./wasm tests/sample_test_1.pptx
 *
 * ## How it works
 *
 * When compiled, there are no separate worker script files on disk.
 * The binary re-executes itself with a special `--libreoffice-subprocess` flag
 * to spawn worker processes. This is detected at the entry point:
 *
 * 1. `isBunSubprocess()` checks if `--libreoffice-subprocess` is in argv
 * 2. If yes, `runBunSubprocess()` enters the IPC message loop (never returns)
 * 3. If no, the main application logic runs
 *
 * The `BunSubprocessConverter` automatically handles this spawning pattern.
 */

import {
  isBunSubprocess,
  runBunSubprocess,
  BunSubprocessConverter,
  rgbaToPng,
} from '../../src/bun.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

// ─── Subprocess entry point ──────────────────────────────
// This MUST be checked before any other application logic.
// When the compiled binary is re-executed as a subprocess,
// it enters worker mode and never reaches the main() function.
if (isBunSubprocess()) {
  await runBunSubprocess();
  // This line is never reached
}

// ─── Parse command-line arguments ────────────────────────

function printUsage() {
  console.log('Usage: ppt-to-images [options] <input-file>');
  console.log('');
  console.log('Convert a PPT/PPTX file to PNG images.');
  console.log('');
  console.log('Options:');
  console.log('  --wasm-path <path>  Path to the wasm/ directory (default: ./wasm)');
  console.log('  --output <dir>      Output directory (default: ./output)');
  console.log('  --width <pixels>    Image width in pixels (default: 1920)');
  console.log('  --help              Show this help message');
}

let wasmPath = './wasm';
let outputDir = './output';
let width = 1920;
let inputFile = '';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  switch (arg) {
    case '--wasm-path':
      if (i + 1 >= args.length) { console.error('Missing value for --wasm-path'); process.exit(1); }
      wasmPath = args[++i]!;
      break;
    case '--output':
      if (i + 1 >= args.length) { console.error('Missing value for --output'); process.exit(1); }
      outputDir = args[++i]!;
      break;
    case '--width':
      if (i + 1 >= args.length) { console.error('Missing value for --width'); process.exit(1); }
      width = parseInt(args[++i]!, 10);
      break;
    case '--help':
      printUsage();
      process.exit(0);
      break;
    default:
      if (arg.startsWith('-')) {
        console.error(`Unknown option: ${arg}`);
        printUsage();
        process.exit(1);
      }
      inputFile = arg;
  }
}

if (!inputFile) {
  console.error('Error: No input file specified.');
  printUsage();
  process.exit(1);
}

// ─── Main application ────────────────────────────────────

async function main() {
  console.log('PPT to Images Converter (Bun compiled binary)');
  console.log('='.repeat(50));

  // Validate input
  const resolvedInput = resolve(inputFile);
  if (!existsSync(resolvedInput)) {
    console.error(`File not found: ${resolvedInput}`);
    process.exit(1);
  }

  const resolvedWasm = resolve(wasmPath);
  if (!existsSync(resolvedWasm)) {
    console.error(`WASM directory not found: ${resolvedWasm}`);
    console.error('Specify the path with --wasm-path <path>');
    process.exit(1);
  }

  console.log(`Input:  ${resolvedInput}`);
  console.log(`WASM:   ${resolvedWasm}`);
  console.log(`Output: ${resolve(outputDir)}`);
  console.log(`Width:  ${width}px\n`);

  // Read input file
  const inputData = await readFile(resolvedInput);
  const ext = resolvedInput.split('.').pop()?.toLowerCase() || 'pptx';

  // Initialize the converter
  // BunSubprocessConverter auto-detects compiled binary mode and
  // spawns the current executable with --libreoffice-subprocess
  console.log('Initializing converter...');
  const converter = new BunSubprocessConverter({
    wasmPath: resolvedWasm,
    verbose: false,
  });
  await converter.initialize();
  console.log('✓ Converter ready!\n');

  // Get page count
  const pageCount = await converter.getPageCount(inputData, { inputFormat: ext });
  console.log(`Document has ${pageCount} page(s)/slide(s)`);

  // Create output directory
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Render each page as an image
  const pageIndices = Array.from({ length: pageCount }, (_, i) => i);
  const previews = await converter.renderPagePreviews(
    inputData,
    { inputFormat: ext },
    { width, pageIndices },
  );

  // Save as PNG
  for (const preview of previews) {
    const pngData = await rgbaToPng(preview.data, preview.width, preview.height);
    const outPath = join(outputDir, `page-${String(preview.page + 1).padStart(3, '0')}.png`);
    await writeFile(outPath, pngData);
    console.log(`✓ page-${String(preview.page + 1).padStart(3, '0')}.png (${preview.width}×${preview.height})`);
  }

  // Cleanup
  await converter.destroy();

  console.log(`\n✓ Done! ${previews.length} image(s) saved to ${resolve(outputDir)}`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\n✗ Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
