/**
 * Bun Document Conversion Example
 *
 * Converts a PPTX (or other document) file to PNG images, one per slide/page.
 *
 * Script mode:
 *   bun examples/bun-conversion.ts tests/sample_test_1.pptx
 *   → saves images to ./converted/
 *
 * Compiled single-file executable:
 *   bun build --compile --outfile bun-conversion examples/bun-conversion.ts
 *   ./bun-conversion tests/sample_test_1.pptx
 *   → saves images to ./converted-single/
 *
 * Note: Requires Node.js to be installed (used internally for WASM processing).
 */

import { BunSubprocessConverter } from '../src/bun.subprocess-converter.js';
import * as fs from 'fs';
import * as path from 'path';

// Detect compiled mode: in a compiled Bun binary, Bun.main starts with /$bunfs/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bunGlobal = (globalThis as any).Bun;
const isCompiled = !!(bunGlobal && typeof bunGlobal.main === 'string' && bunGlobal.main.startsWith('/$bunfs/'));

// In compiled mode, argv is ['bun', '/$bunfs/root/...', ...userArgs]
// In script mode, argv is ['/path/to/bun', 'examples/bun-conversion.ts', ...userArgs]
const inputFile = isCompiled ? process.argv[2] : process.argv[2];
if (!inputFile) {
  const cmd = isCompiled
    ? `./bun-conversion <input-file>`
    : `bun examples/bun-conversion.ts <input-file>`;
  console.error(`Usage: ${cmd}`);
  console.error('Example: ' + (isCompiled
    ? `./bun-conversion tests/sample_test_1.pptx`
    : `bun examples/bun-conversion.ts tests/sample_test_1.pptx`));
  process.exit(1);
}

// Resolve paths
const inputPath = path.resolve(inputFile);
if (!fs.existsSync(inputPath)) {
  console.error(`Error: Input file not found: ${inputPath}`);
  process.exit(1);
}

// Output directory depends on mode
const outputDir = path.resolve(isCompiled ? './converted-single' : './converted');

// WASM path: in compiled mode use CWD, in script mode resolve from script location
const projectRoot = isCompiled
  ? process.cwd()
  : path.resolve(path.dirname(process.argv[1] || '.'), '..');
const wasmPath = path.resolve(projectRoot, 'wasm');

async function main() {
  const mode = isCompiled ? 'compiled single-file' : 'script';
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  LibreOffice WASM Converter - Bun Example               ║');
  console.log(`║  Mode: ${mode.padEnd(49)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`Input:      ${inputPath}`);
  console.log(`Output dir: ${outputDir}`);
  console.log(`WASM path:  ${wasmPath}\n`);

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // Create the converter (spawns a Node.js subprocess for WASM processing)
  console.log('Initializing converter (Node.js subprocess for WASM)...');
  const converter = new BunSubprocessConverter({
    wasmPath,
    verbose: false,
  });
  await converter.initialize();
  console.log('Converter ready!\n');

  // Read input file
  const inputBuffer = fs.readFileSync(inputPath);
  const ext = path.extname(inputPath).slice(1).toLowerCase();

  // Get page count
  console.log('Getting page count...');
  const pageCount = await converter.getPageCount(inputBuffer, {
    inputFormat: ext as 'pptx' | 'docx' | 'pdf' | 'odt' | 'odp' | 'xlsx',
  });
  console.log(`Document has ${pageCount} page(s)\n`);

  // Render each page as a PNG preview and encode with sharp (or fallback)
  const baseName = path.basename(inputPath, path.extname(inputPath));
  console.log('Rendering pages to PNG...');

  // Get RGBA pixel data for all pages
  const previews = await converter.renderPagePreviews(
    inputBuffer,
    { inputFormat: ext as 'pptx' | 'docx' | 'pdf' | 'odt' | 'odp' | 'xlsx' },
    { width: 1280, pageIndices: Array.from({ length: pageCount }, (_, i) => i) },
  );

  // Encode to PNG using the library's image utilities
  const { encodeImage } = await import('../src/image-utils.js');

  for (const preview of previews) {
    const pngData = await encodeImage(preview.data, preview.width, preview.height, { format: 'png' });
    const outputFile = path.join(outputDir, `${baseName}_page_${preview.page + 1}.png`);
    fs.writeFileSync(outputFile, pngData);
    console.log(`  ✓ Page ${preview.page + 1}/${pageCount}: ${outputFile} (${pngData.length.toLocaleString()} bytes)`);
  }

  // Clean up
  console.log('\nCleaning up...');
  await converter.destroy();

  console.log('\n─────────────────────────────────────────');
  console.log(`✓ Done! ${pageCount} image(s) saved to ${outputDir}`);
  console.log('─────────────────────────────────────────');

  process.exit(0);
}

main().catch((error) => {
  console.error('\n✗ Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
