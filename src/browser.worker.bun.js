'use strict';

const workerEntrypoint =
  typeof __filename === 'string' && __filename.includes('/dist/')
    ? './browser.worker.global.js'
    : './browser.worker.ts';

require(workerEntrypoint);
