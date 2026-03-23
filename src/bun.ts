/**
 * LibreOffice WASM Document Converter - Bun Entry Point
 *
 * This entry point provides Bun-compatible document conversion by delegating
 * WASM processing to a Node.js subprocess. Your Bun code handles the
 * application logic while Node.js handles the Emscripten WASM execution.
 *
 * @example
 * ```typescript
 * import { createBunSubprocessConverter } from '@matbee/libreoffice-converter/bun';
 *
 * const converter = await createBunSubprocessConverter({ wasmPath: './wasm' });
 * const result = await converter.convert(docxBuffer, { outputFormat: 'pdf' });
 * await converter.destroy();
 * ```
 *
 * @packageDocumentation
 */

// ============================================
// Bun-specific converter
// ============================================

export { BunSubprocessConverter, createBunSubprocessConverter } from './bun.subprocess-converter.js';

// ============================================
// Re-exports from the main library
// ============================================

export { LibreOfficeConverter } from './converter-node.js';

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
  DocumentCategory,
  WasmLoadPhase,
  WasmLoadProgress,
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
