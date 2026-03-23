import { basename, extname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConverter } from '../src/bun.js';

declare const LIBREOFFICE_BUN_COMPILED: boolean | string | undefined;

const isCompiled = typeof LIBREOFFICE_BUN_COMPILED !== 'undefined' &&
  (LIBREOFFICE_BUN_COMPILED === true || LIBREOFFICE_BUN_COMPILED === 'true');

function normalizeCliPath(value: string): string {
  return resolve(value.replace(/\\/g, '/'));
}

async function main() {
  const inputArg = Bun.argv[2];
  if (!inputArg) {
    console.error('Usage: bun examples/bun-conversion.ts <presentation.pptx>');
    process.exitCode = 1;
    return;
  }

  const inputPath = normalizeCliPath(inputArg);
  const inputFile = Bun.file(inputPath);
  if (!(await inputFile.exists())) {
    console.error(`Input file not found: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const inputData = new Uint8Array(await inputFile.arrayBuffer());
  const outputDir = resolve(isCompiled ? './converted-single' : './converted');
  const converter = await createConverter({ wasmPath: resolve('./wasm') });

  try {
    const pageCount = await converter.getPageCount(inputData, { inputFormat: 'pptx' });
    const baseName = basename(inputPath, extname(inputPath));

    await mkdir(outputDir, { recursive: true });

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const result = await converter.convert(
        inputData,
        {
          inputFormat: 'pptx',
          outputFormat: 'png',
          image: {
            pageIndex,
            width: 1600,
          },
        },
        basename(inputPath)
      );

      const targetPath = resolve(outputDir, `${baseName}-slide-${pageIndex + 1}.png`);
      await writeFile(targetPath, result.data);
      console.log(`Wrote ${targetPath}`);
    }
  } finally {
    await converter.destroy();
  }
}

await main();
