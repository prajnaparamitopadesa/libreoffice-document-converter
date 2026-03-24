import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createBunConverter } from '../src/bun.js';
import type { InputFormat } from '../src/types.js';

function getCliInputPath(): string {
  const inputPath = process.argv.at(-1);
  if (!inputPath || inputPath.startsWith('-')) {
    throw new Error('Usage: bun examples/bun-conversion.ts <input.pptx>');
  }
  return inputPath;
}

function getOutputDirectory(): string {
  return process.argv.length > 2 ? 'converted' : 'converted-single';
}

async function main(): Promise<void> {
  const inputPath = resolve(process.cwd(), getCliInputPath());
  const outputDir = resolve(process.cwd(), getOutputDirectory());
  const repoRoot = process.cwd();

  const inputData = await readFile(inputPath);
  const inputFormat = (extname(inputPath).slice(1).toLowerCase() || 'pptx') as InputFormat;
  const converter = await createBunConverter({
    wasmPath: resolve(repoRoot, 'wasm'),
    browserWorkerJs: pathToFileURL(resolve(repoRoot, 'src/browser.worker.ts')).href,
    verbose: false,
  });

  try {
    await mkdir(outputDir, { recursive: true });

    const pageCount = await converter.getPageCount(inputData, { inputFormat });
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const result = await converter.convert(inputData, {
        outputFormat: 'png',
        inputFormat,
        image: { pageIndex },
      }, basename(inputPath));

      const targetPath = resolve(outputDir, `slide-${pageIndex + 1}.png`);
      await writeFile(targetPath, result.data);
      console.log(`wrote ${targetPath}`);
    }
  } finally {
    await converter.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
