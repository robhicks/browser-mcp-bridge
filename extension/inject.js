// Injected into the page context to access page-level JavaScript

(function() {
  const consoleLogs = [];
  const maxLogs = 1000;

  // Intercept console methods
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug
  };

  const captureLog = (type, args) => {
    const log = {
      type,
      timestamp: Date.now(),
      message: args.map(arg => {
        try {
          if (typeof arg === 'object') {
            return JSON.stringify(arg, null, 2);
          }
          return String(arg);
        } catch (e) {
          return '[Unable to serialize]';
        }
      }).join(' '),
      stack: new Error().stack
    };

    consoleLogs.push(log);
    if (consoleLogs.length > maxLogs) {
      consoleLogs.shift();
    }
  };

  // Override console methods
  console.log = function(...args) {
    captureLog('log', args);
    originalConsole.log.apply(console, args);
  };

  console.error = function(...args) {
    captureLog('error', args);
    originalConsole.error.apply(console, args);
  };

  console.warn = function(...args) {
    captureLog('warn', args);
    originalConsole.warn.apply(console, args);
  };

  console.info = function(...args) {
    captureLog('info', args);
    originalConsole.info.apply(console, args);
  };

  console.debug = function(...args) {
    captureLog('debug', args);
    originalConsole.debug.apply(console, args);
  };

  // Listen for messages from content script
  window.addEventListener('message', (event) => {
    if (event.data.type === 'EXECUTE_SCRIPT') {
      try {
        const result = eval(event.data.script);
        window.postMessage({
          type: 'SCRIPT_RESULT',
          result: result
        }, '*');
      } catch (error) {
        window.postMessage({
          type: 'SCRIPT_RESULT',
          result: {
            error: error.message,
            stack: error.stack
          }
        }, '*');
      }
    } else if (event.data.type === 'GET_CONSOLE_LOGS') {
      window.postMessage({
        type: 'CONSOLE_LOGS',
        logs: consoleLogs
      }, '*');
    }
  });

  // Capture network requests
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const startTime = performance.now();
    const request = {
      url: args[0],
      method: args[1]?.method || 'GET',
      headers: args[1]?.headers,
      timestamp: Date.now()
    };

    return originalFetch.apply(this, args).then(response => {
      const duration = performance.now() - startTime;
      window.postMessage({
        type: 'NETWORK_REQUEST',
        request,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          duration
        }
      }, '*');
      return response;
    }).catch(error => {
      window.postMessage({
        type: 'NETWORK_REQUEST',
        request,
        error: error.message
      }, '*');
      throw error;
    });
  };

  // Capture XHR requests
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._requestInfo = {
      method,
      url,
      timestamp: Date.now()
    };
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function(data) {
    const startTime = performance.now();
    
    this.addEventListener('load', () => {
      const duration = performance.now() - startTime;
      window.postMessage({
        type: 'NETWORK_REQUEST',
        request: this._requestInfo,
        response: {
          status: this.status,
          statusText: this.statusText,
          responseText: this.responseText,
          duration
        }
      }, '*');
    });

    this.addEventListener('error', () => {
      window.postMessage({
        type: 'NETWORK_REQUEST',
        request: this._requestInfo,
        error: 'XHR request failed'
      }, '*');
    });

    return originalXHRSend.apply(this, [data]);
  };

  // Capture unhandled errors
  window.addEventListener('error', (event) => {
    window.postMessage({
      type: 'PAGE_ERROR',
      error: {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack
      }
    }, '*');
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    window.postMessage({
      type: 'UNHANDLED_REJECTION',
      error: {
        reason: event.reason,
        promise: String(event.promise)
      }
    }, '*');
  });
})();