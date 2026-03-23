const result = await Bun.build({
  entrypoints: ['./examples/bun-conversion.ts'],
  compile: {
    outfile: './bun-conversion',
  },
  target: 'bun',
  minify: false,
  sourcemap: 'none',
  loaders: {
    '.cjs': 'text',
    '.wasm': 'file',
    '.data': 'file',
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log('Built ./bun-conversion');
