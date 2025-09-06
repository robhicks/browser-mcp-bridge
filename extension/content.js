// Content script - Extracts page data and communicates with background script

class PageDataExtractor {
  constructor() {
    this.setupMessageListener();
    this.injectPageScript();
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      switch (request.action) {
        case 'getPageContent':
          sendResponse(this.getPageContent());
          break;
        case 'getDOMSnapshot':
          sendResponse(this.getDOMSnapshot());
          break;
        case 'getComputedStyles':
          sendResponse(this.getComputedStyles(request.selector));
          break;
        case 'executeScript':
          this.executeInPageContext(request.script, sendResponse);
          return true; // Will respond asynchronously
        case 'getPerformanceMetrics':
          sendResponse(this.getPerformanceMetrics());
          break;
        case 'getAccessibilityTree':
          sendResponse(this.getAccessibilityTree());
          break;
        case 'captureConsoleLog':
          this.captureConsoleLog(sendResponse);
          return true;
      }
    });
  }

  injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  getPageContent() {
    return {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      metadata: {
        viewport: document.querySelector('meta[name="viewport"]')?.content,
        description: document.querySelector('meta[name="description"]')?.content,
        keywords: document.querySelector('meta[name="keywords"]')?.content,
        ogTitle: document.querySelector('meta[property="og:title"]')?.content,
        ogDescription: document.querySelector('meta[property="og:description"]')?.content,
      },
      cookies: document.cookie,
      localStorage: this.getLocalStorage(),
      sessionStorage: this.getSessionStorage()
    };
  }

  getDOMSnapshot() {
    const snapshot = {
      nodeCount: document.querySelectorAll('*').length,
      structure: this.serializeDOM(document.documentElement),
      forms: this.extractForms(),
      links: this.extractLinks(),
      images: this.extractImages(),
      scripts: this.extractScripts(),
      stylesheets: this.extractStylesheets()
    };
    return snapshot;
  }

  serializeDOM(element, depth = 0, maxDepth = 10) {
    if (depth > maxDepth) return null;
    
    const node = {
      tagName: element.tagName,
      id: element.id || undefined,
      className: element.className || undefined,
      attributes: {},
      children: []
    };

    for (const attr of element.attributes) {
      node.attributes[attr.name] = attr.value;
    }

    for (const child of element.children) {
      const serializedChild = this.serializeDOM(child, depth + 1, maxDepth);
      if (serializedChild) {
        node.children.push(serializedChild);
      }
    }

    return node;
  }

  extractForms() {
    return Array.from(document.forms).map(form => ({
      name: form.name,
      id: form.id,
      action: form.action,
      method: form.method,
      fields: Array.from(form.elements).map(field => ({
        name: field.name,
        type: field.type,
        id: field.id,
        value: field.type !== 'password' ? field.value : '[REDACTED]',
        required: field.required
      }))
    }));
  }

  extractLinks() {
    return Array.from(document.links).map(link => ({
      href: link.href,
      text: link.innerText,
      target: link.target,
      rel: link.rel
    }));
  }

  extractImages() {
    return Array.from(document.images).map(img => ({
      src: img.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    }));
  }

  extractScripts() {
    return Array.from(document.scripts).map(script => ({
      src: script.src,
      type: script.type,
      async: script.async,
      defer: script.defer,
      inline: !script.src
    }));
  }

  extractStylesheets() {
    return Array.from(document.styleSheets).map(sheet => {
      try {
        return {
          href: sheet.href,
          type: sheet.type,
          media: sheet.media.mediaText,
          disabled: sheet.disabled,
          ruleCount: sheet.cssRules ? sheet.cssRules.length : 0
        };
      } catch (e) {
        // Cross-origin stylesheets may throw
        return {
          href: sheet.href,
          error: 'Cross-origin stylesheet'
        };
      }
    });
  }

  getComputedStyles(selector) {
    try {
      const elements = selector ? document.querySelectorAll(selector) : [document.body];
      return Array.from(elements).map(el => {
        const styles = window.getComputedStyle(el);
        const result = {};
        for (let i = 0; i < styles.length; i++) {
          const prop = styles[i];
          result[prop] = styles.getPropertyValue(prop);
        }
        return {
          selector: selector || 'body',
          styles: result,
          boundingBox: el.getBoundingClientRect()
        };
      });
    } catch (e) {
      return { error: e.message };
    }
  }

  executeInPageContext(script, callback) {
    window.addEventListener('message', function responseHandler(event) {
      if (event.data.type === 'SCRIPT_RESULT') {
        window.removeEventListener('message', responseHandler);
        callback(event.data.result);
      }
    });

    window.postMessage({
      type: 'EXECUTE_SCRIPT',
      script: script
    }, '*');
  }

  getPerformanceMetrics() {
    const perf = window.performance;
    const timing = perf.timing;
    const navigation = perf.navigation;
    
    return {
      timing: {
        loadTime: timing.loadEventEnd - timing.fetchStart,
        domContentLoaded: timing.domContentLoadedEventEnd - timing.fetchStart,
        domInteractive: timing.domInteractive - timing.fetchStart,
        firstPaint: perf.getEntriesByType('paint')[0]?.startTime,
        firstContentfulPaint: perf.getEntriesByType('paint')[1]?.startTime
      },
      navigation: {
        type: navigation.type,
        redirectCount: navigation.redirectCount
      },
      resources: perf.getEntriesByType('resource').map(r => ({
        name: r.name,
        type: r.initiatorType,
        duration: r.duration,
        size: r.transferSize
      })),
      memory: performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      } : null
    };
  }

  getAccessibilityTree() {
    const getAccessibleName = (element) => {
      return element.getAttribute('aria-label') || 
             element.getAttribute('alt') || 
             element.innerText || 
             element.getAttribute('title') || 
             '';
    };

    const getRole = (element) => {
      return element.getAttribute('role') || 
             element.tagName.toLowerCase();
    };

    const buildTree = (element, depth = 0, maxDepth = 5) => {
      if (depth > maxDepth) return null;
      
      const node = {
        role: getRole(element),
        name: getAccessibleName(element),
        focusable: element.tabIndex >= 0,
        ariaAttributes: {},
        children: []
      };

      // Collect ARIA attributes
      for (const attr of element.attributes) {
        if (attr.name.startsWith('aria-')) {
          node.ariaAttributes[attr.name] = attr.value;
        }
      }

      // Process children
      for (const child of element.children) {
        const childNode = buildTree(child, depth + 1, maxDepth);
        if (childNode) {
          node.children.push(childNode);
        }
      }

      return node;
    };

    return buildTree(document.body);
  }

  getLocalStorage() {
    const storage = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      storage[key] = localStorage.getItem(key);
    }
    return storage;
  }

  getSessionStorage() {
    const storage = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      storage[key] = sessionStorage.getItem(key);
    }
    return storage;
  }

  captureConsoleLog(callback) {
    // Listen for console messages from the injected script
    window.addEventListener('message', function handler(event) {
      if (event.data.type === 'CONSOLE_LOGS') {
        window.removeEventListener('message', handler);
        callback(event.data.logs);
      }
    });

    window.postMessage({ type: 'GET_CONSOLE_LOGS' }, '*');
  }
}

// Initialize the extractor
const extractor = new PageDataExtractor();