import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUN_SUBPROCESS_FLAG,
  getBunSelfSpawnCommand,
  isBunRuntime,
  isBunSubprocessEntrypoint,
  isNodeRuntime,
  shouldUseSubprocessConversion,
} from '../src/runtime.js';

describe('runtime helpers', () => {
  it('detects Bun without treating it as plain Node.js', () => {
    const proc = {
      versions: {
        bun: '1.2.0',
        node: '20.0.0',
      },
    };

    expect(isBunRuntime(proc)).toBe(true);
    expect(isNodeRuntime(proc)).toBe(false);
    expect(shouldUseSubprocessConversion(proc)).toBe(false);
  });

  it('uses subprocess conversion for plain Node.js runtimes', () => {
    const proc = {
      versions: {
        node: '20.0.0',
      },
    };

    expect(isBunRuntime(proc)).toBe(false);
    expect(isNodeRuntime(proc)).toBe(true);
    expect(shouldUseSubprocessConversion(proc)).toBe(true);
  });

  it('builds a Bun self-spawn command for script mode', () => {
    expect(
      getBunSelfSpawnCommand({
        execPath: '/usr/local/bin/bun',
        argv: ['/usr/local/bin/bun', '/app/examples/bun-single-file.ts'],
        workerArgs: ['input.pptx', 'out'],
      })
    ).toEqual([
      '/usr/local/bin/bun',
      '/app/examples/bun-single-file.ts',
      DEFAULT_BUN_SUBPROCESS_FLAG,
      'input.pptx',
      'out',
    ]);
  });

  it('builds a Bun self-spawn command for compiled executables', () => {
    expect(
      getBunSelfSpawnCommand({
        execPath: '/app/bin/convert-ppt',
        argv: ['/app/bin/convert-ppt'],
        workerArgs: ['input.pptx', 'out'],
      })
    ).toEqual([
      '/app/bin/convert-ppt',
      DEFAULT_BUN_SUBPROCESS_FLAG,
      'input.pptx',
      'out',
    ]);
  });

  it('detects Bun subprocess entrypoint flags', () => {
    expect(isBunSubprocessEntrypoint(['bun', DEFAULT_BUN_SUBPROCESS_FLAG])).toBe(true);
    expect(isBunSubprocessEntrypoint(['bun', 'examples/demo.ts'])).toBe(false);
  });
});
