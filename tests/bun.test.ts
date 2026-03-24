import { describe, expect, it } from 'vitest';

import { createBunWasmPaths, createBunWorkerOptions } from '../src/bun.js';

describe('Bun helpers', () => {
  it('creates file URLs for an explicit wasm directory', () => {
    const paths = createBunWasmPaths('/tmp/libreoffice-wasm');

    expect(paths).toEqual({
      sofficeJs: 'file:///tmp/libreoffice-wasm/soffice.js',
      sofficeWasm: 'file:///tmp/libreoffice-wasm/soffice.wasm',
      sofficeData: 'file:///tmp/libreoffice-wasm/soffice.data',
      sofficeWorkerJs: 'file:///tmp/libreoffice-wasm/soffice.worker.js',
    });
  });

  it('builds worker options without requiring Bun-specific callers to provide every asset path', () => {
    const options = createBunWorkerOptions({
      wasmPath: '/tmp/libreoffice-wasm',
      browserWorkerJs: '/tmp/browser.worker.ts',
      verbose: true,
    });

    expect(options.browserWorkerJs).toBe('file:///tmp/browser.worker.ts');
    expect(options.sofficeJs).toBe('file:///tmp/libreoffice-wasm/soffice.js');
    expect(options.sofficeWasm).toBe('file:///tmp/libreoffice-wasm/soffice.wasm');
    expect(options.sofficeData).toBe('file:///tmp/libreoffice-wasm/soffice.data');
    expect(options.sofficeWorkerJs).toBe('file:///tmp/libreoffice-wasm/soffice.worker.js');
    expect(options.verbose).toBe(true);
  });

  it('uses the Bun classic-worker wrapper by default', () => {
    const options = createBunWorkerOptions({
      wasmPath: '/tmp/libreoffice-wasm',
    });

    expect(options.browserWorkerJs).toMatch(/browser\.worker\.bun\.js$/);
  });
});
