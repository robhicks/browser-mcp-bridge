// Background service worker - Manages WebSocket connection to MCP server

class MCPBridge {
  constructor() {
    this.ws = null;
    this.wsUrl = 'ws://localhost:6009/mcp'; // Default fallback
    this.reconnectInterval = 5000;
    this.activeTab = null;
    this.debuggerAttached = new Set();
    this.isReconnecting = false;
    this.popupPorts = new Set();
    this.reconnectTimer = null;
    this.minReconnectDisplayTime = 2000; // Show reconnecting state for at least 2 seconds
    
    this.loadConfiguration().then(() => {
      this.initializeConnection();
    });
    this.setupMessageHandlers();
    this.setupDebugger();
  }

  async loadConfiguration() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['serverUrl'], (result) => {
        if (result.serverUrl) {
          this.wsUrl = result.serverUrl;
        }
        resolve();
      });
    });
  }

  initializeConnection() {
    this.connect();
  }

  connect(isReconnectAttempt = false) {
    try {
      // Clear any existing reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      
      // Only set reconnecting state if this is actually a reconnection attempt
      if (isReconnectAttempt) {
        this.isReconnecting = true;
        this.broadcastStatus();
      }
      
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.onopen = () => {
        console.log('Connected to MCP server');
        this.isReconnecting = false;
        this.broadcastStatus();
        this.sendToMCP({
          type: 'connection',
          status: 'connected',
          timestamp: Date.now()
        });
      };

      this.ws.onmessage = (event) => {
        this.handleMCPMessage(JSON.parse(event.data));
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        // Don't immediately clear reconnecting state - let scheduleReconnect handle it
      };

      this.ws.onclose = () => {
        console.log('Disconnected from MCP server');
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('Failed to connect:', error);
      this.scheduleReconnect();
    }
  }

  sendToMCP(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not connected');
    }
  }

  scheduleReconnect() {
    // First show disconnected state
    this.isReconnecting = false;
    this.broadcastStatus();
    
    // Schedule reconnect attempt after a delay
    this.reconnectTimer = setTimeout(() => {
      // Show reconnecting state briefly during actual reconnect attempt
      this.isReconnecting = true;
      this.broadcastStatus();
      
      // Small delay to ensure reconnecting state is visible, then attempt connection
      setTimeout(() => {
        this.connect(true); // Pass true to indicate this is a reconnection attempt
      }, 500); // Show "Reconnecting..." for 500ms
    }, this.reconnectInterval); // Wait 5 seconds before attempting reconnect
  }

  broadcastStatus() {
    // Broadcast status to all connected popup ports
    const statusMessage = {
      type: 'status',
      connected: this.ws?.readyState === WebSocket.OPEN,
      reconnecting: this.isReconnecting,
      url: this.wsUrl
    };
    
    this.popupPorts.forEach(port => {
      try {
        port.postMessage(statusMessage);
      } catch (error) {
        // Remove disconnected ports
        this.popupPorts.delete(port);
      }
    });
  }

  setupMessageHandlers() {
    // Handle messages from content scripts
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'content-data') {
        this.sendToMCP({
          type: 'browser-data',
          source: 'content-script',
          tabId: sender.tab.id,
          url: sender.tab.url,
          data: request.data
        });
      }
      return true;
    });

    // Handle messages from popup
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'popup') {
        // Track popup port for status broadcasts
        this.popupPorts.add(port);
        
        // Clean up when popup disconnects
        port.onDisconnect.addListener(() => {
          this.popupPorts.delete(port);
        });
        
        port.onMessage.addListener((msg) => {
          switch (msg.action) {
            case 'getStatus':
              port.postMessage({
                type: 'status',
                connected: this.ws?.readyState === WebSocket.OPEN,
                reconnecting: this.isReconnecting,
                url: this.wsUrl
              });
              break;
            
            case 'connect':
              if (msg.url) {
                this.wsUrl = msg.url;
                // Save the new URL to storage
                chrome.storage.sync.set({ serverUrl: msg.url });
              }
              this.connect();
              break;
            
            case 'disconnect':
              // Clear reconnecting state and timers
              this.isReconnecting = false;
              if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
              }
              if (this.ws) {
                this.ws.close();
              }
              this.broadcastStatus();
              break;
            
            case 'captureTab':
              if (msg.tabId) {
                this.captureTabData(msg.tabId);
              }
              break;
          }
        });
      }
    });

    // Handle messages from DevTools
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'devtools') {
        port.onMessage.addListener((msg) => {
          this.handleDevToolsMessage(msg, port);
        });
      }
    });
  }

  setupDebugger() {
    // Listen for debugger events
    chrome.debugger.onEvent.addListener((source, method, params) => {
      this.sendToMCP({
        type: 'debugger-event',
        source,
        method,
        params,
        timestamp: Date.now()
      });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      this.debuggerAttached.delete(source.tabId);
      console.log(`Debugger detached from tab ${source.tabId}: ${reason}`);
    });
  }

  async handleMCPMessage(message) {
    console.log('Received MCP message:', message);
    
    switch (message.action) {
      case 'getPageContent':
        await this.getPageContent(message.tabId);
        break;
      
      case 'getDOMSnapshot':
        await this.getDOMSnapshot(message.tabId);
        break;
      
      case 'executeScript':
        await this.executeScript(message.tabId, message.script);
        break;
      
      case 'getNetworkData':
        await this.getNetworkData(message.tabId);
        break;
      
      case 'getConsoleMessages':
        await this.getConsoleMessages(message.tabId);
        break;
      
      case 'attachDebugger':
        await this.attachDebugger(message.tabId);
        break;
      
      case 'detachDebugger':
        await this.detachDebugger(message.tabId);
        break;
      
      case 'captureScreenshot':
        await this.captureScreenshot(message.tabId);
        break;
      
      case 'getPerformanceMetrics':
        await this.getPerformanceMetrics(message.tabId);
        break;
      
      case 'getCookies':
        await this.getCookies(message.url);
        break;
      
      case 'getStorageData':
        await this.getStorageData(message.tabId);
        break;
      
      case 'emulateDevice':
        await this.emulateDevice(message.tabId, message.device);
        break;
      
      case 'setUserAgent':
        await this.setUserAgent(message.tabId, message.userAgent);
        break;
      
      case 'getAllTabs':
        await this.getAllTabs();
        break;
      
      default:
        console.warn('Unknown action:', message.action);
    }
  }

  async getPageContent(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getPageContent'
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'getPageContent',
        tabId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getPageContent',
        tabId,
        error: error.message
      });
    }
  }

  async getDOMSnapshot(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getDOMSnapshot'
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'getDOMSnapshot',
        tabId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getDOMSnapshot',
        tabId,
        error: error.message
      });
    }
  }

  async executeScript(tabId, script) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'executeScript',
        script
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'executeScript',
        tabId,
        result: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'executeScript',
        tabId,
        error: error.message
      });
    }
  }

  async attachDebugger(tabId) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, '1.3');
        this.debuggerAttached.add(tabId);
        
        // Enable necessary domains
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
        await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
        await chrome.debugger.sendCommand({ tabId }, 'CSS.enable');
        await chrome.debugger.sendCommand({ tabId }, 'Overlay.enable');
        
        this.sendToMCP({
          type: 'response',
          action: 'attachDebugger',
          tabId,
          status: 'attached'
        });
      }
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'attachDebugger',
        tabId,
        error: error.message
      });
    }
  }

  async detachDebugger(tabId) {
    try {
      if (this.debuggerAttached.has(tabId)) {
        await chrome.debugger.detach({ tabId });
        this.debuggerAttached.delete(tabId);
        
        this.sendToMCP({
          type: 'response',
          action: 'detachDebugger',
          tabId,
          status: 'detached'
        });
      }
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'detachDebugger',
        tabId,
        error: error.message
      });
    }
  }

  async getNetworkData(tabId) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await this.attachDebugger(tabId);
      }

      const result = await chrome.debugger.sendCommand(
        { tabId },
        'Network.getResponseBody',
        { requestId: 'latest' }
      );

      this.sendToMCP({
        type: 'response',
        action: 'getNetworkData',
        tabId,
        data: result
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getNetworkData',
        tabId,
        error: error.message
      });
    }
  }

  async getConsoleMessages(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'captureConsoleLog'
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'getConsoleMessages',
        tabId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getConsoleMessages',
        tabId,
        error: error.message
      });
    }
  }

  async captureScreenshot(tabId) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: 'png',
        quality: 100
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'captureScreenshot',
        tabId,
        data: dataUrl
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'captureScreenshot',
        tabId,
        error: error.message
      });
    }
  }

  async getPerformanceMetrics(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getPerformanceMetrics'
      });
      
      this.sendToMCP({
        type: 'response',
        action: 'getPerformanceMetrics',
        tabId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getPerformanceMetrics',
        tabId,
        error: error.message
      });
    }
  }

  async getCookies(url) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      
      this.sendToMCP({
        type: 'response',
        action: 'getCookies',
        url,
        data: cookies
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getCookies',
        url,
        error: error.message
      });
    }
  }

  async getStorageData(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url);
      
      // Get local storage
      const localStorage = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
          }
          return data;
        }
      });

      // Get session storage
      const sessionStorage = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const data = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            data[key] = sessionStorage.getItem(key);
          }
          return data;
        }
      });

      this.sendToMCP({
        type: 'response',
        action: 'getStorageData',
        tabId,
        data: {
          localStorage: localStorage[0].result,
          sessionStorage: sessionStorage[0].result
        }
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getStorageData',
        tabId,
        error: error.message
      });
    }
  }

  async emulateDevice(tabId, device) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await this.attachDebugger(tabId);
      }

      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setDeviceMetricsOverride',
        device
      );

      this.sendToMCP({
        type: 'response',
        action: 'emulateDevice',
        tabId,
        status: 'success'
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'emulateDevice',
        tabId,
        error: error.message
      });
    }
  }

  async setUserAgent(tabId, userAgent) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await this.attachDebugger(tabId);
      }

      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setUserAgentOverride',
        { userAgent }
      );

      this.sendToMCP({
        type: 'response',
        action: 'setUserAgent',
        tabId,
        status: 'success'
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'setUserAgent',
        tabId,
        error: error.message
      });
    }
  }

  async getAllTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      
      this.sendToMCP({
        type: 'response',
        action: 'getAllTabs',
        data: tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
          index: tab.index
        }))
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        action: 'getAllTabs',
        error: error.message
      });
    }
  }

  async captureTabData(tabId) {
    try {
      // Capture multiple types of data for the tab
      await Promise.all([
        this.getPageContent(tabId),
        this.getDOMSnapshot(tabId),
        this.getConsoleMessages(tabId),
        this.getPerformanceMetrics(tabId)
      ]);
    } catch (error) {
      console.error('Error capturing tab data:', error);
    }
  }

  handleDevToolsMessage(message, port) {
    // Forward DevTools messages to MCP server
    this.sendToMCP({
      type: 'devtools-message',
      tabId: message.tabId,
      data: message.data
    });
  }
}

// Initialize the bridge
const bridge = new MCPBridge();