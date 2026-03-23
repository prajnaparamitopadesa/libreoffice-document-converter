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
 *
 * Note: Node.js must be installed for the WASM subprocess.
 */

import { BunSubprocessConverter } from '../src/bun.js';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, basename, extname, join } from 'path';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage:');
    console.log('  bun examples/bun-conversion.ts <input-file> [output-dir]');
    console.log('  ./bun-conversion <input-file> [output-dir]');
    process.exit(1);
  }

  const inputPath = resolve(args[0]!);

  // Detect compiled binary mode
  const execBase = process.execPath.replace(/\\/g, '/').split('/').pop() || '';
  const isCompiled = execBase !== 'bun' && execBase !== 'bun.exe';

  const defaultOutputDir = isCompiled ? './converted-single' : './converted';
  const outputDir = resolve(args[1] || defaultOutputDir);

  console.log('🔄 LibreOffice WASM Document Converter (Bun)');
  console.log('');
  console.log(`   Mode:    ${isCompiled ? '📦 Compiled binary' : '📝 Script'}`);
  console.log(`   Input:   ${inputPath}`);
  console.log(`   Output:  ${outputDir}`);
  console.log('');

  mkdirSync(outputDir, { recursive: true });

  console.log('📖 Reading input file...');
  const inputData = readFileSync(inputPath);
  const inputExt = extname(inputPath).slice(1).toLowerCase();
  const inputName = basename(inputPath, extname(inputPath));
  console.log(`   Size: ${(inputData.length / 1024).toFixed(2)} KB, Format: ${inputExt.toUpperCase()}`);
  console.log('');

  console.log('⚙️  Initializing LibreOffice WASM subprocess...');
  const startInit = Date.now();

  const converter = new BunSubprocessConverter({
    wasmPath: './wasm',
    verbose: false,
  });

  await converter.initialize();
  console.log(`✅ Initialized in ${((Date.now() - startInit) / 1000).toFixed(1)}s`);
  console.log('');

  console.log('📊 Analyzing document...');
  const pageCount = await converter.getPageCount(inputData, inputExt);
  console.log(`   Pages: ${pageCount}`);
  console.log('');

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
    console.log(`   ✅ Page ${i + 1}/${pageCount}: ${(result.data.length / 1024).toFixed(1)} KB (${Date.now() - pageStart}ms)`);
  }

  const totalTime = Date.now() - convertStart;
  console.log('');
  console.log(`✨ Done! ${pageCount} page(s) converted in ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`   Output directory: ${outputDir}`);

  await converter.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
