'use strict';

(function () {
  const globalScope = globalThis;
  const originalRequire = typeof globalScope.require === 'function' ? globalScope.require : null;

  if (!originalRequire) {
    throw new Error('Bun LibreOffice bootstrap requires require() support');
  }

  const fs = originalRequire('fs');
  const bootstrapUrl = new URL(globalScope.location?.href || '', 'file:///').href;
  const sofficeUrl = new URL('./soffice.js', bootstrapUrl).href;

  function evaluateClassicScript(scriptUrl) {
    const source = fs.readFileSync(new URL(scriptUrl), 'utf8');
    const evaluator = new Function(
      'Module',
      'mainScriptUrlOrBlob',
      `${source}\n//# sourceURL=${scriptUrl}`
    );

    const previousProcess = globalScope.process;
    const previousRequire = globalScope.require;
    const previousModule = globalScope.module;

    try {
      globalScope.process = undefined;
      globalScope.require = undefined;
      globalScope.module = undefined;
      globalScope.Module = globalScope.Module || {};
      globalScope.Module.mainScriptUrlOrBlob = bootstrapUrl;
      evaluator(globalScope.Module, bootstrapUrl);
    } finally {
      globalScope.process = previousProcess;
      globalScope.require = previousRequire;
      globalScope.module = previousModule;
    }
  }

  globalScope.importScripts = (...urls) => {
    for (const url of urls) {
      const resolvedUrl = new URL(url, bootstrapUrl).href;
      evaluateClassicScript(resolvedUrl === bootstrapUrl ? sofficeUrl : resolvedUrl);
    }
  };

  evaluateClassicScript(sofficeUrl);
})();
