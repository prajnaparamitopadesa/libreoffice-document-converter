/**
 * Bun Script Mode Example - PPT to Images
 *
 * Demonstrates using the LibreOffice WASM converter with Bun in script mode.
 * This is the simplest way to use the library - just `bun run` this file.
 *
 * Usage:
 *   bun run examples/bun-conversion.ts
 *
 * Or with a custom PPT file:
 *   bun run examples/bun-conversion.ts path/to/slides.pptx
 */

import { createSubprocessConverter, rgbaToPng, isSharpAvailable } from '../dist/bun.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   LibreOffice WASM - Bun Script Mode Example             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ─── Determine input file ────────────────────────────────
  const inputPath = process.argv[2] || join(__dirname, '..', 'tests', 'sample_test_1.pptx');

  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error('Usage: bun run examples/bun-conversion.ts [path/to/file.pptx]');
    process.exit(1);
  }

  console.log(`Input file: ${inputPath}`);
  const inputData = await readFile(inputPath);
  console.log(`File size:  ${(inputData.length / 1024).toFixed(1)} KB\n`);

  // ─── Initialize converter ────────────────────────────────
  console.log('Initializing converter (subprocess mode)...');
  const converter = await createSubprocessConverter({
    wasmPath: join(__dirname, '..', 'wasm'),
    verbose: false,
  });
  console.log('✓ Converter ready!\n');

  // ─── Convert PPT to PDF ──────────────────────────────────
  console.log('─── Converting PPTX → PDF ───');
  const pdfResult = await converter.convert(inputData, {
    outputFormat: 'pdf',
    inputFormat: 'pptx',
  }, 'slides.pptx');

  console.log(`  Output:   ${pdfResult.filename}`);
  console.log(`  Size:     ${(pdfResult.data.length / 1024).toFixed(1)} KB`);
  console.log(`  Duration: ${pdfResult.duration}ms\n`);

  // ─── Render slides as images ─────────────────────────────
  console.log('─── Rendering slide previews ───');
  const pageCount = await converter.getPageCount(inputData, { inputFormat: 'pptx' });
  console.log(`  Total slides: ${pageCount}`);

  const maxSlides = Math.min(pageCount, 3); // Render up to 3 slides
  const previews = await converter.renderPagePreviews(inputData, { inputFormat: 'pptx' }, {
    width: 1280,
    pageIndices: Array.from({ length: maxSlides }, (_, i) => i),
  });

  console.log(`  Rendered ${previews.length} slide(s)\n`);

  // ─── Save outputs ────────────────────────────────────────
  const outputDir = '/tmp/bun-libreoffice-output';
  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  // Save PDF
  const pdfPath = join(outputDir, 'slides.pdf');
  await writeFile(pdfPath, pdfResult.data);
  console.log(`✓ Saved PDF:  ${pdfPath}`);

  // Save slide images as PNG
  const sharpAvailable = await isSharpAvailable();
  console.log(`  Image encoder: ${sharpAvailable ? 'sharp (native)' : 'pure JS fallback'}`);

  for (const preview of previews) {
    const pngData = await rgbaToPng(preview.data, preview.width, preview.height);
    const pngPath = join(outputDir, `slide-${preview.page}.png`);
    await writeFile(pngPath, pngData);
    console.log(`✓ Saved PNG:  ${pngPath} (${preview.width}×${preview.height})`);
  }

  // ─── Cleanup ─────────────────────────────────────────────
  await converter.destroy();

  console.log('\n─────────────────────────────────────────');
  console.log(`✓ All done! Output directory: ${outputDir}`);
  console.log('─────────────────────────────────────────');

  process.exit(0);
}

main().catch((error) => {
  console.error('\n✗ Error:', error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
