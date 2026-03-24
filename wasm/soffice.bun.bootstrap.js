'use strict';

(function () {
  const globalScope = globalThis;
  const originalRequire =
    typeof require === 'function'
      ? require
      : typeof globalScope.require === 'function'
        ? globalScope.require
        : null;

  if (!originalRequire) {
    throw new Error('Bun LibreOffice bootstrap requires require() support');
  }

  const fs = originalRequire('fs');
  const workerThreads = originalRequire('worker_threads');
  const bunMain = globalScope.Bun?.main;
  const bootstrapHref =
    globalScope.__libreofficeBunBootstrapUrl ||
    globalScope.location?.href ||
    (typeof bunMain === 'string' ? new URL(bunMain, 'file://').href : undefined);
  if (!bootstrapHref) {
    throw new Error('Bun LibreOffice bootstrap requires an explicit bootstrap URL');
  }
  const bootstrapUrl = new URL(bootstrapHref).href;
  const sofficeUrl = new URL('./soffice.js', bootstrapUrl).href;

  function evaluateClassicScript(scriptUrl) {
    const source = fs.readFileSync(new URL(scriptUrl), 'utf8');
    const evaluator = new Function(
      'Module',
      'mainScriptUrlOrBlob',
      `var process = undefined;\nvar require = undefined;\nvar module = undefined;\n${source}\n//# sourceURL=${scriptUrl}`
    );

    const previousWorkerGlobalScope = globalScope.WorkerGlobalScope;
    const previousLocation = globalScope.location;
    const previousFetch = globalScope.fetch;
    const previousXMLHttpRequest = globalScope.XMLHttpRequest;
    const previousName = globalScope.name;

    try {
      if (typeof globalScope.WorkerGlobalScope === 'undefined') {
        globalScope.WorkerGlobalScope = function WorkerGlobalScope() {};
      }
      if (!globalScope.location) {
        globalScope.location = new URL(bootstrapUrl);
      }
      if (!globalScope.name && typeof workerThreads.workerData === 'string') {
        globalScope.name = workerThreads.workerData;
      }
      if (typeof previousFetch === 'function') {
        globalScope.fetch = (input, init) => {
          const resolvedInput =
            typeof input === 'string' && !/^[a-zA-Z]+:/.test(input)
              ? new URL(input, bootstrapUrl).href
              : input;
          return previousFetch.call(globalScope, resolvedInput, init);
        };
      }
      if (typeof globalScope.XMLHttpRequest === 'undefined') {
        globalScope.XMLHttpRequest = class BunXMLHttpRequest {
          constructor() {
            this.readyState = 0;
            this.status = 0;
            this.statusText = '';
            this.responseType = '';
            this.response = null;
            this.responseText = '';
            this.onreadystatechange = null;
            this.onload = null;
            this.onerror = null;
            this._url = '';
          }

          open(_method, url) {
            this._url = url;
            this.readyState = 1;
          }

          overrideMimeType() {}

          setRequestHeader() {}

          send() {
            try {
              const resolvedUrl =
                typeof this._url === 'string' && !/^[a-zA-Z]+:/.test(this._url)
                  ? new URL(this._url, bootstrapUrl)
                  : new URL(this._url);
              const data = fs.readFileSync(resolvedUrl);

              this.status = 200;
              this.statusText = 'OK';
              this.readyState = 4;
              if (this.responseType === 'arraybuffer') {
                this.response = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              } else {
                this.responseText = data.toString('utf8');
                this.response = this.responseText;
              }

              if (this.onreadystatechange) this.onreadystatechange();
              if (this.onload) this.onload();
            } catch (error) {
              this.status = 404;
              this.statusText = 'Not Found';
              this.readyState = 4;
              if (this.onreadystatechange) this.onreadystatechange();
              if (this.onerror) this.onerror(error);
            }
          }
        };
      }
      globalScope.Module = globalScope.Module || {};
      globalScope.Module.mainScriptUrlOrBlob = bootstrapUrl;
      evaluator(globalScope.Module, bootstrapUrl);
    } finally {
      globalScope.WorkerGlobalScope = previousWorkerGlobalScope;
      globalScope.location = previousLocation;
      globalScope.fetch = previousFetch;
      globalScope.XMLHttpRequest = previousXMLHttpRequest;
      globalScope.name = previousName;
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
