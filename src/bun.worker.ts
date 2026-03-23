import {
  createDirectBunConverter,
  decodeBinary,
  encodeBinary,
} from './bun.js';
import type { BunWasmAssets } from './bun.js';
import type { ConversionOptions, InputFormatOptions, LibreOfficeWasmOptions } from './types.js';
import { ConversionError, ConversionErrorCode } from './types.js';

type WorkerRequest =
  | { id: number; type: 'init'; payload: { options?: LibreOfficeWasmOptions; assets?: BunWasmAssets } }
  | { id: number; type: 'convert'; payload: { input: string; options: ConversionOptions; filename?: string } }
  | { id: number; type: 'getPageCount'; payload: { input: string; options: InputFormatOptions } }
  | { id: number; type: 'destroy'; payload?: undefined };

let converter: Awaited<ReturnType<typeof createDirectBunConverter>> | null = null;

function respond(id: number, success: boolean, data?: unknown, error?: string): void {
  postMessage({ id, success, data, error });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === 'init') {
      converter = await createDirectBunConverter({
        ...(request.payload.options ?? {}),
        assets: request.payload.assets,
      });
      respond(request.id, true);
      return;
    }

    if (!converter) {
      throw new ConversionError(ConversionErrorCode.WASM_NOT_INITIALIZED, 'Bun worker converter is not initialized');
    }

    if (request.type === 'convert') {
      const result = await converter.convert(
        decodeBinary(request.payload.input),
        request.payload.options,
        request.payload.filename
      );
      respond(request.id, true, {
        data: encodeBinary(result.data),
        mimeType: result.mimeType,
        filename: result.filename,
        duration: result.duration,
      });
      return;
    }

    if (request.type === 'getPageCount') {
      const pageCount = await converter.getPageCount(
        decodeBinary(request.payload.input),
        request.payload.options
      );
      respond(request.id, true, pageCount);
      return;
    }

    if (request.type === 'destroy') {
      await converter.destroy();
      converter = null;
      respond(request.id, true);
      return;
    }
  } catch (error) {
    respond(request.id, false, undefined, error instanceof Error ? error.message : String(error));
  }
};
