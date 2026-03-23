/**
 * Bun script-mode example: convert a PPT/PPTX file into PNG slide images.
 *
 * Usage:
 *   bun examples/bun-ppt-to-images.ts input.pptx output-dir
 */

import { mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import wasmLoader from '../wasm/loader.cjs';
import { createConverter } from '../src/index.js';

const wasmPath = fileURLToPath(new URL('../wasm', import.meta.url));

async function main() {
  const [inputPath, outputDir] = process.argv.slice(2);

  if (!inputPath || !outputDir) {
    console.log('Usage: bun examples/bun-ppt-to-images.ts <input.pptx> <output-dir>');
    process.exit(1);
  }

  const input = await Bun.file(resolve(inputPath)).bytes();
  const filename = basename(inputPath);
  const inputFormat = extname(filename).slice(1).toLowerCase() || 'pptx';
  const converter = await createConverter({
    wasmPath,
    wasmLoader,
    verbose: true,
  });

  try {
    const pageCount = await converter.getPageCount(input, { inputFormat });
    await mkdir(resolve(outputDir), { recursive: true });

    const baseName = basename(filename, extname(filename));
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const image = await converter.convert(input, {
        outputFormat: 'png',
        inputFormat,
        image: {
          pageIndex,
          width: 1600,
        },
      }, filename);

      const outputPath = join(resolve(outputDir), `${baseName}-slide-${pageIndex + 1}.png`);
      await Bun.write(outputPath, image.data);
      console.log(`Wrote ${outputPath}`);
    }
  } finally {
    await converter.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
