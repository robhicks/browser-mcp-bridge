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
          sendResponse(this.getAccessibilityTree(request.timeout));
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

  getAccessibilityTree(customTimeout) {
    const startTime = Date.now();
    // Use custom timeout if provided, otherwise default to 28 seconds
    const serverTimeout = customTimeout ? Math.min(customTimeout - 2000, 118000) : 28000;
    const MAX_PROCESSING_TIME = Math.max(serverTimeout, 5000); // Minimum 5 seconds
    const MAX_NODES = 2000; // Increased limit for thorough analysis
    
    console.log(`[ACCESSIBILITY] Starting analysis with ${MAX_PROCESSING_TIME/1000}s timeout (custom: ${customTimeout})`);
    let processedNodes = 0;

    const getAccessibleName = (element) => {
      // Check for timeout
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        throw new Error(`Accessibility tree processing timeout after ${MAX_PROCESSING_TIME/1000}s`);
      }
      
      return element.getAttribute('aria-label') || 
             element.getAttribute('alt') || 
             (element.innerText ? element.innerText.substring(0, 100) : '') || // Limit text length
             element.getAttribute('title') || 
             '';
    };

    const getRole = (element) => {
      return element.getAttribute('role') || 
             element.tagName.toLowerCase();
    };

    const isAccessibilityRelevant = (element) => {
      // Check for any accessibility-relevant attributes or semantic elements
      const hasAriaAttrs = element.hasAttribute('role') ||
                          element.hasAttribute('aria-label') ||
                          element.hasAttribute('aria-labelledby') ||
                          element.hasAttribute('aria-describedby') ||
                          element.hasAttribute('aria-expanded') ||
                          element.hasAttribute('aria-selected') ||
                          element.hasAttribute('aria-checked') ||
                          element.hasAttribute('aria-disabled') ||
                          element.hasAttribute('aria-hidden') ||
                          element.hasAttribute('aria-live') ||
                          element.hasAttribute('aria-owns') ||
                          element.hasAttribute('aria-controls');

      const isFocusable = element.tabIndex >= 0 || 
                         ['input', 'select', 'textarea', 'button', 'a'].includes(element.tagName.toLowerCase());

      const isSemanticElement = ['button', 'a', 'input', 'select', 'textarea', 'img', 
                               'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 
                               'section', 'article', 'aside', 'header', 'footer', 
                               'form', 'fieldset', 'legend', 'label', 'table', 
                               'th', 'td', 'caption', 'dl', 'dt', 'dd', 'ul', 
                               'ol', 'li', 'figure', 'figcaption', 'details', 
                               'summary', 'dialog'].includes(element.tagName.toLowerCase());

      const hasInteractiveContent = element.onclick || element.onkeydown || 
                                   element.style.cursor === 'pointer';

      return hasAriaAttrs || isFocusable || isSemanticElement || hasInteractiveContent;
    };

    const buildTree = (element, depth = 0, maxDepth = 5) => {
      // Check limits
      if (depth > maxDepth || 
          processedNodes >= MAX_NODES || 
          Date.now() - startTime > MAX_PROCESSING_TIME) {
        console.log(`[ACCESSIBILITY] Processing stopped - depth: ${depth}, nodes: ${processedNodes}, time: ${(Date.now() - startTime)/1000}s`);
        return null;
      }
      
      processedNodes++;
      
      const tagName = element.tagName.toLowerCase();
      const computedStyle = window.getComputedStyle(element);
      
      const node = {
        tagName,
        role: getRole(element),
        name: getAccessibleName(element),
        focusable: element.tabIndex >= 0,
        tabIndex: element.tabIndex,
        visible: computedStyle.display !== 'none' && 
                computedStyle.visibility !== 'hidden' && 
                computedStyle.opacity !== '0',
        ariaAttributes: {},
        semanticInfo: {},
        accessibilityIssues: [],
        children: []
      };

      // Collect comprehensive ARIA attributes
      const allAriaAttrs = ['aria-label', 'aria-labelledby', 'aria-describedby', 
                           'aria-expanded', 'aria-selected', 'aria-checked', 
                           'aria-disabled', 'aria-hidden', 'aria-live', 
                           'aria-owns', 'aria-controls', 'aria-haspopup',
                           'aria-pressed', 'aria-current', 'aria-level',
                           'aria-posinset', 'aria-setsize', 'aria-orientation',
                           'aria-sort', 'aria-required', 'aria-invalid',
                           'aria-readonly', 'aria-multiselectable', 'aria-multiline'];
      
      for (const attr of allAriaAttrs) {
        if (element.hasAttribute(attr)) {
          node.ariaAttributes[attr] = element.getAttribute(attr);
        }
      }

      // Semantic information for specific elements
      if (tagName === 'input') {
        node.semanticInfo.type = element.type;
        node.semanticInfo.required = element.required;
        node.semanticInfo.disabled = element.disabled;
        node.semanticInfo.placeholder = element.placeholder;
      } else if (tagName === 'img') {
        node.semanticInfo.alt = element.alt;
        node.semanticInfo.decorative = !element.alt && element.getAttribute('role') === 'presentation';
      } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        node.semanticInfo.headingLevel = parseInt(tagName.substring(1));
      } else if (tagName === 'a') {
        node.semanticInfo.href = element.href;
        node.semanticInfo.target = element.target;
      } else if (tagName === 'button') {
        node.semanticInfo.type = element.type;
        node.semanticInfo.disabled = element.disabled;
      } else if (tagName === 'table') {
        node.semanticInfo.caption = element.caption?.textContent;
        node.semanticInfo.headers = Array.from(element.querySelectorAll('th')).length;
      }

      // Check for common accessibility issues
      if (tagName === 'img' && !element.alt && element.getAttribute('role') !== 'presentation') {
        node.accessibilityIssues.push('Missing alt text');
      }
      
      if ((tagName === 'input' && element.type !== 'hidden') || tagName === 'textarea' || tagName === 'select') {
        const hasLabel = element.getAttribute('aria-label') || 
                        element.getAttribute('aria-labelledby') ||
                        document.querySelector(`label[for="${element.id}"]`) ||
                        element.closest('label');
        if (!hasLabel) {
          node.accessibilityIssues.push('Form control missing label');
        }
      }

      if (node.focusable && !node.visible) {
        node.accessibilityIssues.push('Focusable element is not visible');
      }

      if (element.onclick && !node.focusable && !['a', 'button', 'input', 'select', 'textarea'].includes(tagName)) {
        node.accessibilityIssues.push('Interactive element not keyboard accessible');
      }

      // Check color contrast for text elements
      if (element.innerText && element.innerText.trim()) {
        const color = computedStyle.color;
        const backgroundColor = computedStyle.backgroundColor;
        if (color && backgroundColor && color !== backgroundColor) {
          // Basic contrast check - in a real implementation you'd calculate the actual contrast ratio
          node.semanticInfo.hasColorContrast = true;
        }
      }

      // Process only accessibility-relevant children
      for (const child of element.children) {
        if (isAccessibilityRelevant(child)) {
          const childNode = buildTree(child, depth + 1, maxDepth);
          if (childNode) {
            node.children.push(childNode);
          }
        }
      }

      return node;
    };

    // Helper function to collect accessibility statistics
    const collectAccessibilityStats = (node, stats = { 
      totalNodes: 0, 
      totalIssues: 0, 
      issueTypes: {},
      headingLevels: {},
      ariaUsage: {},
      roleUsage: {},
      focusableElements: 0,
      visibleElements: 0
    }) => {
      if (!node) return stats;
      
      stats.totalNodes++;
      
      if (node.accessibilityIssues.length > 0) {
        stats.totalIssues += node.accessibilityIssues.length;
        node.accessibilityIssues.forEach(issue => {
          stats.issueTypes[issue] = (stats.issueTypes[issue] || 0) + 1;
        });
      }
      
      if (node.semanticInfo.headingLevel) {
        const level = `h${node.semanticInfo.headingLevel}`;
        stats.headingLevels[level] = (stats.headingLevels[level] || 0) + 1;
      }
      
      if (node.role && node.role !== node.tagName) {
        stats.roleUsage[node.role] = (stats.roleUsage[node.role] || 0) + 1;
      }
      
      Object.keys(node.ariaAttributes).forEach(attr => {
        stats.ariaUsage[attr] = (stats.ariaUsage[attr] || 0) + 1;
      });
      
      if (node.focusable) stats.focusableElements++;
      if (node.visible) stats.visibleElements++;
      
      node.children.forEach(child => collectAccessibilityStats(child, stats));
      
      return stats;
    };

    try {
      const result = buildTree(document.body);
      const accessibilityStats = collectAccessibilityStats(result);
      
      return {
        tree: result,
        summary: {
          ...accessibilityStats,
          processingTime: Date.now() - startTime,
          truncated: processedNodes >= MAX_NODES || Date.now() - startTime > MAX_PROCESSING_TIME,
          recommendations: generateAccessibilityRecommendations(accessibilityStats)
        }
      };
    } catch (error) {
      return {
        error: error.message,
        summary: {
          processedNodes,
          processingTime: Date.now() - startTime,
          truncated: true
        }
      };
    }
    
    // Helper function to generate accessibility recommendations
    function generateAccessibilityRecommendations(stats) {
      const recommendations = [];
      
      if (stats.issueTypes['Missing alt text']) {
        recommendations.push(`${stats.issueTypes['Missing alt text']} images need alt text for screen readers`);
      }
      
      if (stats.issueTypes['Form control missing label']) {
        recommendations.push(`${stats.issueTypes['Form control missing label']} form controls need accessible labels`);
      }
      
      if (stats.issueTypes['Interactive element not keyboard accessible']) {
        recommendations.push(`${stats.issueTypes['Interactive element not keyboard accessible']} interactive elements need keyboard accessibility`);
      }
      
      const headingCount = Object.values(stats.headingLevels).reduce((a, b) => a + b, 0);
      if (headingCount === 0) {
        recommendations.push('Consider adding heading structure for better content organization');
      }
      
      if (stats.focusableElements < 3) {
        recommendations.push('Consider adding keyboard navigation to interactive elements');
      }
      
      return recommendations;
    }
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
console.log('[DEBUG] Content script loaded on:', window.location.href);
const extractor = new PageDataExtractor();
console.log('[DEBUG] PageDataExtractor initialized, ready to receive messages');