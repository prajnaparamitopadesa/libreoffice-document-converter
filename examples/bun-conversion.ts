import { basename, extname, join } from 'path';
import { mkdir } from 'fs/promises';
import {
  createBunSubprocessConverter,
  getDefaultOutputDirectory,
  isBunSubprocess,
  runBunSubprocess,
} from '../src/bun.ts';
import type { BunWasmAssets } from '../src/bun.ts';
import sofficeSource from '../wasm/soffice.cjs' with { type: 'text' };
import sofficeWasmPath from '../wasm/soffice.wasm' with { type: 'file' };
import sofficeDataPath from '../wasm/soffice.data' with { type: 'file' };

const assets: BunWasmAssets = {
  sofficeSource,
  sofficeWasmPath,
  sofficeDataPath,
};

if (isBunSubprocess(Bun.argv)) {
  await runBunSubprocess({ assets });
  process.exit(0);
}

function getInputFormat(inputPath: string): 'ppt' | 'pptx' {
  const extension = extname(inputPath).slice(1).toLowerCase();
  if (extension === 'ppt' || extension === 'pptx') {
    return extension;
  }
  throw new Error(`Unsupported input format: .${extension}. This example only handles PPT/PPTX.`);
}

async function main(): Promise<void> {
  const [, , inputPath, outputDirArg] = Bun.argv;

  if (!inputPath) {
    console.log('Usage: bun examples/bun-conversion.ts <input.ppt|input.pptx> [outputDir]');
    console.log('');
    console.log('Examples:');
    console.log('  bun examples/bun-conversion.ts tests/sample_test_1.pptx');
    console.log('  ./bun-conversion tests/sample_test_1.pptx');
    process.exit(1);
  }

  const inputFormat = getInputFormat(inputPath);
  const inputData = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
  const outputDir = outputDirArg ?? getDefaultOutputDirectory(Bun.argv);
  const documentName = basename(inputPath);
  const documentBaseName = basename(inputPath, extname(inputPath));

  await mkdir(outputDir, { recursive: true });

  console.log('🔄 Bun LibreOffice conversion example');
  console.log(`   Input:      ${inputPath}`);
  console.log(`   Output dir: ${outputDir}`);
  console.log(`   Runtime:    ${outputDir.includes('single') ? 'compiled executable' : 'bun script'}`);
  console.log('');

  const converter = await createBunSubprocessConverter({ assets });

  try {
    const pageCount = await converter.getPageCount(inputData, { inputFormat });
    console.log(`📄 Rendering ${pageCount} slide(s) to PNG...`);

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const result = await converter.convert(
        inputData,
        {
          inputFormat,
          outputFormat: 'png',
          image: { pageIndex },
        },
        documentName
      );

      const outputPath = join(
        outputDir,
        `${documentBaseName}-${String(pageIndex + 1).padStart(2, '0')}.png`
      );
      await Bun.write(outputPath, result.data);
      console.log(`   ✓ ${outputPath}`);
    }

    console.log('');
    console.log('✨ Conversion finished');
  } finally {
    await converter.destroy();
  }
}

await main();
