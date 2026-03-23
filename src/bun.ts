/**
 * Bun entry point for LibreOffice WASM document conversion.
 *
 * Bun needs the WASM loader to be wired in statically so the runtime and
 * compiled executables can resolve the emitted LibreOffice assets reliably.
 */

import { createRequire } from 'module';
import { LibreOfficeConverter } from './converter-node.js';

// Font loading utilities
export { loadFontsFromZip, loadFontsFromDirectory, loadSystemFonts, loadFontsFromPackage, loadFontsFromPackages } from './font-loader.js';

// Image encoding utilities
export {
  encodeImage,
  rgbaToPng,
  rgbaToJpeg,
  rgbaToWebp,
  isSharpAvailable,
  getSharp,
} from './image-utils.js';
export type { ImageEncodeOptions } from './image-utils.js';

export type {
  ConversionOptions,
  ConversionResult,
  FontData,
  ImageOptions,
  InputFormat,
  LibreOfficeWasmOptions,
  OutputFormat,
  PdfOptions,
  ProgressInfo,
  WasmLoaderModule,
} from './types.js';

export {
  ConversionError,
  ConversionErrorCode,
  FORMAT_FILTERS,
  FORMAT_MIME_TYPES,
  EXTENSION_TO_FORMAT,
  getValidOutputFormats,
  isConversionValid,
  getConversionErrorMessage,
  INPUT_FORMAT_CATEGORY,
  CATEGORY_OUTPUT_FORMATS,
  LOKDocumentType,
  LOK_DOCTYPE_OUTPUT_FORMATS,
  getOutputFormatsForDocType,
  createWasmPaths,
  DEFAULT_WASM_BASE_URL,
} from './types.js';

export type { DocumentCategory, WasmLoadPhase, WasmLoadProgress } from './types.js';

// Export LOK constants for advanced usage
export {
  LOK_MOUSEEVENT_BUTTONDOWN,
  LOK_MOUSEEVENT_BUTTONUP,
  LOK_MOUSEEVENT_MOVE,
  LOK_KEYEVENT_KEYINPUT,
  LOK_KEYEVENT_KEYUP,
  LOK_SELTYPE_NONE,
  LOK_SELTYPE_TEXT,
  LOK_SELTYPE_CELL,
  LOK_SETTEXTSELECTION_START,
  LOK_SETTEXTSELECTION_END,
  LOK_SETTEXTSELECTION_RESET,
  LOK_DOCTYPE_TEXT,
  LOK_DOCTYPE_SPREADSHEET,
  LOK_DOCTYPE_PRESENTATION,
  LOK_DOCTYPE_DRAWING,
  LOK_DOCTYPE_OTHER,
} from './lok-bindings.js';

import type {
  ConversionOptions,
  ConversionResult,
  ImageOptions,
  LibreOfficeWasmOptions,
  WasmLoaderModule,
} from './types.js';

export { LibreOfficeConverter };

export type ImageFormat = 'png' | 'jpg' | 'svg';

const require = createRequire(import.meta.url);
const defaultBunWasmLoader = require('../wasm/loader.cjs') as WasmLoaderModule;

export function withBunDefaults(options: LibreOfficeWasmOptions = {}): LibreOfficeWasmOptions {
  return {
    wasmPath: './wasm',
    ...options,
    wasmLoader: options.wasmLoader ?? defaultBunWasmLoader,
  };
}

export async function createConverter(
  options?: LibreOfficeWasmOptions
): Promise<LibreOfficeConverter> {
  const converter = new LibreOfficeConverter(withBunDefaults(options));
  await converter.initialize();
  return converter;
}

export async function convertDocument(
  input: Uint8Array | ArrayBuffer | Buffer,
  options: ConversionOptions,
  converterOptions?: LibreOfficeWasmOptions
): Promise<ConversionResult> {
  const converter = await createConverter(converterOptions);
  try {
    return await converter.convert(input, options);
  } finally {
    await converter.destroy();
  }
}

export async function exportAsImage(
  input: Uint8Array | ArrayBuffer | Buffer,
  pages: number | number[],
  format: ImageFormat = 'png',
  imageOptions?: Omit<ImageOptions, 'pageIndex' | 'pages'>,
  converterOptions?: LibreOfficeWasmOptions
): Promise<ConversionResult[]> {
  const pageArray = Array.isArray(pages) ? pages : [pages];
  if (pageArray.length === 0) {
    throw new Error('pages is required and must not be empty');
  }

  const converter = await createConverter(converterOptions);
  try {
    const results: ConversionResult[] = [];
    for (const pageIndex of pageArray) {
      const result = await converter.convert(input, {
        outputFormat: format,
        image: { ...imageOptions, pageIndex },
      });
      results.push(result);
    }
    return results;
  } finally {
    await converter.destroy();
  }
}
