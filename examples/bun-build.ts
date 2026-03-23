const build = Bun.spawn([
  Bun.executable,
  'build',
  './examples/bun-conversion.ts',
  '--compile',
  '--outfile',
  './bun-conversion',
  '--define',
  'LIBREOFFICE_BUN_COMPILED=true',
], {
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
});

const exitCode = await build.exited;
if (exitCode !== 0) {
  throw new Error(`bun build failed with exit code ${exitCode}`);
}
