import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibreOfficeConverter } from '../src/converter-node.js';
import { convertDocument, createConverter, withBunDefaults } from '../src/bun.js';
import type { WasmLoaderModule } from '../src/types.js';

describe('Bun entry point', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects the bundled wasm loader by default', () => {
    const options = withBunDefaults();

    expect(options.wasmPath).toBe('./wasm');
    expect(options.wasmLoader).toBeDefined();
  });

  it('preserves an explicit wasm loader override', () => {
    const customLoader = {
      createModule: vi.fn(),
    } as unknown as WasmLoaderModule;

    const options = withBunDefaults({
      wasmPath: '/custom/wasm',
      wasmLoader: customLoader,
    });

    expect(options.wasmPath).toBe('/custom/wasm');
    expect(options.wasmLoader).toBe(customLoader);
  });

  it('creates a converter with Bun defaults applied', async () => {
    let seenOptions: Record<string, unknown> | undefined;

    vi.spyOn(LibreOfficeConverter.prototype, 'initialize').mockImplementation(async function(this: LibreOfficeConverter & { options?: Record<string, unknown> }) {
      seenOptions = this.options;
    });
    vi.spyOn(LibreOfficeConverter.prototype, 'destroy').mockResolvedValue();

    const converter = await createConverter({ wasmPath: '/custom/wasm' });

    expect(converter).toBeInstanceOf(LibreOfficeConverter);
    expect(seenOptions?.wasmPath).toBe('/custom/wasm');
    expect(seenOptions?.wasmLoader).toBeDefined();

    await converter.destroy();
  });

  it('destroys the converter when conversion fails', async () => {
    vi.spyOn(LibreOfficeConverter.prototype, 'initialize').mockResolvedValue();
    vi.spyOn(LibreOfficeConverter.prototype, 'convert').mockRejectedValue(new Error('boom'));
    const destroySpy = vi.spyOn(LibreOfficeConverter.prototype, 'destroy').mockResolvedValue();

    await expect(
      convertDocument(new Uint8Array([1, 2, 3]), { outputFormat: 'pdf' })
    ).rejects.toThrow('boom');

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
