import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WorkerBrowserConverter } from './browser.js';
import type {
  ConversionOptions,
  ConversionResult,
  ImageOptions,
  WorkerBrowserConverterOptions,
} from './types.js';

type BunManagedOptionKeys =
  | 'browserWorkerJs'
  | 'sofficeJs'
  | 'sofficeWasm'
  | 'sofficeData'
  | 'sofficeWorkerJs';

export interface BunConverterOptions extends Omit<WorkerBrowserConverterOptions, BunManagedOptionKeys> {
  wasmPath?: string | URL;
  browserWorkerJs?: string | URL;
}

function toFileHref(pathOrUrl: string | URL): string {
  if (pathOrUrl instanceof URL) {
    return pathOrUrl.href;
  }

  if (/^[a-zA-Z]+:/.test(pathOrUrl)) {
    return new URL(pathOrUrl).href;
  }

  return pathToFileURL(resolve(pathOrUrl)).href;
}

function defaultWasmBaseUrl(): string {
  return toFileHref(new URL('../wasm/', import.meta.url));
}

function defaultBrowserWorkerUrl(): string {
  return new URL('./browser.worker.bun.js', import.meta.url).href;
}

export function createBunWasmPaths(wasmPath: string | URL = defaultWasmBaseUrl()): {
  sofficeJs: string;
  sofficeWasm: string;
  sofficeData: string;
  sofficeWorkerJs: string;
} {
  const baseUrl = toFileHref(wasmPath);
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return {
    sofficeJs: new URL('soffice.js', normalizedBase).href,
    sofficeWasm: new URL('soffice.wasm', normalizedBase).href,
    sofficeData: new URL('soffice.data', normalizedBase).href,
    sofficeWorkerJs: new URL('soffice.worker.js', normalizedBase).href,
  };
}

export function createBunWorkerOptions(options: BunConverterOptions = {}): WorkerBrowserConverterOptions {
  const { wasmPath = defaultWasmBaseUrl(), browserWorkerJs = defaultBrowserWorkerUrl(), ...rest } = options;

  return {
    ...rest,
    ...createBunWasmPaths(wasmPath),
    browserWorkerJs: toFileHref(browserWorkerJs),
  };
}

export async function createBunConverter(options: BunConverterOptions = {}): Promise<WorkerBrowserConverter> {
  const converter = new WorkerBrowserConverter(createBunWorkerOptions(options));
  await converter.initialize();
  return converter;
}

export async function convertDocument(
  input: Uint8Array | ArrayBuffer,
  options: ConversionOptions,
  converterOptions?: BunConverterOptions
): Promise<ConversionResult> {
  const converter = await createBunConverter(converterOptions);
  try {
    return await converter.convert(input, options);
  } finally {
    await converter.destroy();
  }
}

export async function exportAsImage(
  input: Uint8Array | ArrayBuffer,
  pages: number | number[],
  format: 'png' | 'jpg' | 'svg' = 'png',
  imageOptions?: Omit<ImageOptions, 'pageIndex' | 'pages'>,
  converterOptions?: BunConverterOptions
): Promise<ConversionResult[]> {
  const pageArray = Array.isArray(pages) ? pages : [pages];
  if (pageArray.length === 0) {
    throw new Error('pages is required and must not be empty');
  }

  const converter = await createBunConverter(converterOptions);
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

export { WorkerBrowserConverter as BunConverter } from './browser.js';
export type { ConversionOptions, ConversionResult, ImageOptions } from './types.js';
