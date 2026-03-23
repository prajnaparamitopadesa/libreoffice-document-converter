import { describe, expect, it } from 'vitest';
import {
  getBunSubprocessCommand,
  getDefaultOutputDirectory,
  isBunSubprocess,
} from '../src/bun.js';

describe('Bun helpers', () => {
  it('detects subprocess mode from argv', () => {
    expect(isBunSubprocess(['bun', 'examples/bun-conversion.ts', '--libreoffice-bun-subprocess'])).toBe(true);
    expect(isBunSubprocess(['bun', 'examples/bun-conversion.ts'])).toBe(false);
  });

  it('builds the correct command for script mode', () => {
    expect(getBunSubprocessCommand('examples/bun-conversion.ts', 'examples/bun-conversion.ts', ['bun', 'examples/bun-conversion.ts'])).toEqual([
      process.execPath,
      'examples/bun-conversion.ts',
      '--libreoffice-bun-subprocess',
    ]);
  });

  it('uses the executable directly for compiled mode', () => {
    expect(getBunSubprocessCommand('examples/bun-conversion.ts', process.execPath, [process.execPath])).toEqual([
      process.execPath,
      '--libreoffice-bun-subprocess',
    ]);
    expect(getDefaultOutputDirectory(['/tmp/bun-conversion'])).toBe('./converted');
    expect(getDefaultOutputDirectory([process.execPath], process.execPath)).toBe('./converted-single');
  });
});
