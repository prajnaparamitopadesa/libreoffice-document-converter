/**
 * Bun bundled-executable example.
 *
 * Build:
 *   bun build --compile examples/bun-single-file-ppt-to-images.ts \
 *     --outfile dist/bun-ppt-to-images \
 *     --asset-naming='[name].[ext]'
 *
 * Run:
 *   ./dist/bun-ppt-to-images tests/sample_test_1.pptx ./output
 *
 * The main process respawns the same entrypoint with a flag so the conversion
 * work happens in a short-lived subprocess. This works both in `bun run` mode
 * and in `bun build --compile` output.
 */

import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DEFAULT_BUN_SUBPROCESS_FLAG, createConverter, getBunSelfSpawnCommand, isBunSubprocessEntrypoint } from '../src/index.js';
import wasmLoader from '../wasm/loader.cjs';
import sofficeData from '../wasm/soffice.data' with { type: 'file' };
import '../wasm/soffice.wasm' with { type: 'file' };
import '../wasm/soffice.data.js.metadata' with { type: 'file' };
import '../wasm/soffice.worker.js' with { type: 'file' };
import '../wasm/soffice.worker.cjs' with { type: 'file' };

function getAssetPath(asset: string | { name: string }): string {
  return typeof asset === 'string' ? asset : asset.name;
}

async function runConversion(inputPath: string, outputDir: string) {
  const input = await Bun.file(resolve(inputPath)).bytes();
  const filename = basename(inputPath);
  const inputFormat = extname(filename).slice(1).toLowerCase() || 'pptx';
  const wasmPath = dirname(getAssetPath(sofficeData));
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

async function main() {
  const args = process.argv.slice(2);

  if (isBunSubprocessEntrypoint(process.argv, DEFAULT_BUN_SUBPROCESS_FLAG)) {
    const workerArgs = args.filter((arg) => arg !== DEFAULT_BUN_SUBPROCESS_FLAG);
    const [inputPath, outputDir] = workerArgs;
    if (!inputPath || !outputDir) {
      throw new Error('Worker mode requires <input.pptx> <output-dir>');
    }
    await runConversion(inputPath, outputDir);
    return;
  }

  const [inputPath, outputDir] = args;
  if (!inputPath || !outputDir) {
    console.log('Usage: bun examples/bun-single-file-ppt-to-images.ts <input.pptx> <output-dir>');
    process.exit(1);
  }

  const command = getBunSelfSpawnCommand({
    argv: process.argv,
    execPath: process.execPath,
    workerArgs: [inputPath, outputDir],
  });

  const proc = Bun.spawn(command, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
