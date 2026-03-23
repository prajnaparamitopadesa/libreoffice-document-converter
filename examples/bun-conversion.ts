/**
 * Bun Document Conversion Example
 *
 * Converts a PPTX (or any supported document) to PNG images.
 * Works in both script mode and compiled single-file executable mode.
 *
 * Script mode:
 *   bun examples/bun-conversion.ts tests/sample_test_1.pptx
 *   (images saved to ./converted)
 *
 * Compiled mode:
 *   bun build --compile examples/bun-conversion.ts --outfile bun-conversion
 *   ./bun-conversion tests/sample_test_1.pptx
 *   (images saved to ./converted-single)
 */

import { isBunSubprocess, runBunSubprocessWorker, BunSubprocessConverter } from '../src/bun.js';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, basename, extname, join } from 'path';

// ============================================
// Subprocess entry point
// ============================================
// When the process is re-spawned with --bun-subprocess,
// it runs the worker logic instead of the main conversion.
if (isBunSubprocess()) {
  await runBunSubprocessWorker();
  // runBunSubprocessWorker calls process.exit() internally
}

// ============================================
// Main conversion logic
// ============================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage:');
    console.log('  bun examples/bun-conversion.ts <input-file> [output-dir]');
    console.log('  ./bun-conversion <input-file> [output-dir]');
    console.log('');
    console.log('Examples:');
    console.log('  bun examples/bun-conversion.ts tests/sample_test_1.pptx');
    console.log('  ./bun-conversion tests/sample_test_1.pptx ./my-output');
    process.exit(1);
  }

  const inputPath = resolve(args[0]!);

  // Detect if running as compiled binary
  const execBase = process.execPath.replace(/\\/g, '/').split('/').pop() || '';
  const isCompiled = execBase !== 'bun' && execBase !== 'bun.exe';

  // Default output directory depends on mode
  const defaultOutputDir = isCompiled ? './converted-single' : './converted';
  const outputDir = resolve(args[1] || defaultOutputDir);

  console.log('🔄 LibreOffice WASM Document Converter (Bun)');
  console.log('');
  console.log(`   Mode:    ${isCompiled ? '📦 Compiled binary' : '📝 Script'}`);
  console.log(`   Input:   ${inputPath}`);
  console.log(`   Output:  ${outputDir}`);
  console.log('');

  // Validate input file
  if (!existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Create output directory
  mkdirSync(outputDir, { recursive: true });

  // Read input file
  console.log('📖 Reading input file...');
  const inputData = readFileSync(inputPath);
  const inputExt = extname(inputPath).slice(1).toLowerCase();
  const inputName = basename(inputPath, extname(inputPath));

  console.log(`   Size: ${(inputData.length / 1024).toFixed(2)} KB`);
  console.log(`   Format: ${inputExt.toUpperCase()}`);
  console.log('');

  // Create converter
  console.log('⚙️  Initializing LibreOffice WASM subprocess...');
  const startInit = Date.now();

  const converter = new BunSubprocessConverter({
    wasmPath: './wasm',
    verbose: false,
    entryScript: import.meta.filename,
  });

  await converter.initialize();
  console.log(`✅ Initialized in ${((Date.now() - startInit) / 1000).toFixed(1)}s`);
  console.log('');

  // Get page count first
  console.log('📊 Analyzing document...');
  const pageCount = await converter.getPageCount(inputData, inputExt);
  console.log(`   Pages: ${pageCount}`);
  console.log('');

  // Convert each page to PNG
  console.log('🖼️  Converting pages to PNG...');
  const convertStart = Date.now();

  for (let i = 0; i < pageCount; i++) {
    const pageStart = Date.now();
    const result = await converter.convert(
      inputData,
      {
        outputFormat: 'png',
        inputFormat: inputExt,
        image: { pageIndex: i },
      },
      basename(inputPath)
    );

    const outputPath = join(outputDir, `${inputName}_page_${i + 1}.png`);
    writeFileSync(outputPath, result.data);
    console.log(`   ✅ Page ${i + 1}/${pageCount}: ${(result.data.length / 1024).toFixed(1)} KB (${Date.now() - pageStart}ms) → ${outputPath}`);
  }

  const totalTime = Date.now() - convertStart;
  console.log('');
  console.log(`✨ Done! ${pageCount} page(s) converted in ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`   Output directory: ${outputDir}`);

  // Clean up
  await converter.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
