// DevTools integration script

class DevToolsPanel {
  constructor() {
    this.panelCreated = false;
    this.port = null;
    this.tabId = chrome.devtools.inspectedWindow.tabId;
    
    this.createPanel();
    this.setupCommunication();
  }

  createPanel() {
    chrome.devtools.panels.create(
      'MCP Bridge',
      'icons/icon-16.png',
      'panel.html',
      (panel) => {
        this.panelCreated = true;
        console.log('MCP Bridge panel created');
        
        panel.onShown.addListener(() => {
          console.log('MCP Bridge panel shown');
          this.sendDevToolsData();
        });
      }
    );
  }

  setupCommunication() {
    // Connect to background script
    this.port = chrome.runtime.connect({ name: 'devtools' });
    
    this.port.onMessage.addListener((message) => {
      console.log('DevTools received message:', message);
    });
  }

  async sendDevToolsData() {
    try {
      // Get network resources
      const resources = await this.getNetworkResources();
      
      // Get console messages
      const consoleMessages = await this.getConsoleMessages();
      
      // Get element inspection data
      const inspectedElement = await this.getInspectedElement();
      
      // Send to background script
      this.port.postMessage({
        type: 'devtools-data',
        tabId: this.tabId,
        data: {
          resources,
          consoleMessages,
          inspectedElement,
          timestamp: Date.now()
        }
      });
    } catch (error) {
      console.error('Error collecting DevTools data:', error);
    }
  }

  async getNetworkResources() {
    return new Promise((resolve) => {
      chrome.devtools.network.getHAR((harLog) => {
        resolve({
          entries: harLog.entries.map(entry => ({
            request: {
              method: entry.request.method,
              url: entry.request.url,
              headers: entry.request.headers,
              queryString: entry.request.queryString,
              postData: entry.request.postData
            },
            response: {
              status: entry.response.status,
              statusText: entry.response.statusText,
              headers: entry.response.headers,
              content: entry.response.content
            },
            timings: entry.timings,
            time: entry.time
          }))
        });
      });
    });
  }

  async getConsoleMessages() {
    // This would need to be implemented with proper console API access
    // For now, we'll return a placeholder
    return {
      messages: [],
      count: 0
    };
  }

  async getInspectedElement() {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(
        `
        (function() {
          const selected = $0; // Chrome DevTools selected element
          if (selected) {
            return {
              tagName: selected.tagName,
              id: selected.id,
              className: selected.className,
              innerHTML: selected.innerHTML.substring(0, 1000), // Truncate for safety
              outerHTML: selected.outerHTML.substring(0, 1000),
              computedStyle: window.getComputedStyle(selected),
              boundingRect: selected.getBoundingClientRect(),
              attributes: Array.from(selected.attributes).map(attr => ({
                name: attr.name,
                value: attr.value
              }))
            };
          }
          return null;
        })()
        `,
        (result, isException) => {
          if (isException) {
            console.error('Error getting inspected element:', isException);
            resolve(null);
          } else {
            resolve(result);
          }
        }
      );
    });
  }

  // Method to execute code in the inspected window
  executeInInspectedWindow(code) {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
        if (isException) {
          reject(isException);
        } else {
          resolve(result);
        }
      });
    });
  }

  // Method to reload the inspected window
  reloadInspectedWindow() {
    chrome.devtools.inspectedWindow.reload();
  }
}

// Initialize DevTools integration
const devToolsPanel = new DevToolsPanel();