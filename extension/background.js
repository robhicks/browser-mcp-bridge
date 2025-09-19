// Background service worker - Manages WebSocket connection to MCP server

class MCPBridge {
  constructor() {
    this.ws = null;
    this.wsUrl = 'ws://localhost:6009/ws'; // Default fallback
    this.reconnectInterval = 5000;
    this.activeTab = null;
    this.debuggerAttached = new Set();
    this.isReconnecting = false;
    this.popupPorts = new Set();
    this.reconnectTimer = null;
    this.minReconnectDisplayTime = 2000; // Show reconnecting state for at least 2 seconds
    
    // Connection health monitoring
    this.healthCheckInterval = 10000; // Check connection every 10 seconds
    this.healthCheckTimer = null;
    this.lastPongReceived = null;
    this.pingTimeout = 5000; // Wait 5 seconds for pong response
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3; // Reconnect after 3 failed health checks
    
    // Network request tracking
    this.networkRequests = new Map(); // tabId -> array of requests
    this.maxRequestsPerTab = 200; // Keep last 200 requests per tab
    
    // Debug version identifier to verify extension reload
    const version = `v${Date.now()}`;
    console.log(`[DEBUG] MCPBridge initialized - ${version} - Extension loaded with periodic health checking, dynamic timeouts, and network monitoring`);
    
    this.loadConfiguration().then(() => {
      this.initializeConnection();
      this.startHealthCheck();
    });
    this.setupMessageHandlers();
    this.setupDebugger();
    this.setupNetworkMonitoring();
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
        this.consecutiveFailures = 0; // Reset failure counter on successful connection
        this.lastPongReceived = Date.now();
        this.broadcastStatus();
        this.sendToMCP({
          type: 'connection',
          status: 'connected',
          timestamp: Date.now()
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle pong responses for health checking
          if (data.type === 'pong') {
            this.lastPongReceived = Date.now();
            this.consecutiveFailures = 0;
            console.log('[HEALTH] Received pong response');
            return;
          }
          
          this.handleMCPMessage(data);
        } catch (error) {
          console.error('[DEBUG] Error parsing WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        // Don't immediately clear reconnecting state - let scheduleReconnect handle it
      };

      this.ws.onclose = (event) => {
        console.log('Disconnected from MCP server - Code:', event.code, 'Reason:', event.reason);
        // Force cleanup of any pending message handlers
        this.ws = null;
        this.lastPongReceived = null;
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('Failed to connect:', error);
      this.scheduleReconnect();
    }
  }

  sendToMCP(data) {
    console.log('[DEBUG] sendToMCP called with data:', data);
    console.log('[DEBUG] WebSocket state:', this.ws ? this.ws.readyState : 'no websocket');
    console.log('[DEBUG] WebSocket OPEN constant:', WebSocket.OPEN);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const jsonString = JSON.stringify(data);
        console.log('[DEBUG] Sending to MCP server:', jsonString.substring(0, 200) + '...');
        this.ws.send(jsonString);
        console.log('[DEBUG] WebSocket send completed successfully');
        return true;
      } catch (error) {
        console.error('[DEBUG] Error sending to MCP server:', error);
        // If send fails, close the connection to force reconnect
        this.ws?.close();
        return false;
      }
    } else {
      console.warn('[DEBUG] WebSocket not connected - readyState:', this.ws?.readyState);
      // Try to reconnect if not already reconnecting
      if (!this.isReconnecting) {
        console.log('[DEBUG] Attempting to reconnect...');
        this.connect(true);
      }
      return false;
    }
  }

  scheduleReconnect() {
    // Stop health check during reconnection
    this.stopHealthCheck();
    
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
        // Restart health check after reconnection attempt
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.startHealthCheck();
          }
        }, 1000);
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
              this.stopHealthCheck();
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
        await this.getPageContent(message.tabId, message.requestId);
        break;
      
      case 'getDOMSnapshot':
        await this.getDOMSnapshot(message.tabId, message.requestId);
        break;
      
      case 'executeScript':
        await this.executeScript(message.tabId, message.script, message.requestId);
        break;
      
      case 'getNetworkData':
        await this.getNetworkData(message.tabId, message.requestId);
        break;
      
      case 'getConsoleMessages':
        await this.getConsoleMessages(message.tabId, message.requestId);
        break;
      
      case 'attachDebugger':
        await this.attachDebugger(message.tabId, message.requestId);
        break;
      
      case 'detachDebugger':
        await this.detachDebugger(message.tabId, message.requestId);
        break;
      
      case 'captureScreenshot':
        await this.captureScreenshot(message.tabId, message.requestId);
        break;
      
      case 'getPerformanceMetrics':
        await this.getPerformanceMetrics(message.tabId, message.requestId);
        break;
      
      case 'getAccessibilityTree':
        await this.getAccessibilityTree(message.tabId, message.timeout, message.requestId);
        break;
      
      case 'getCookies':
        await this.getCookies(message.url, message.requestId);
        break;
      
      case 'getStorageData':
        await this.getStorageData(message.tabId, message.requestId);
        break;
      
      case 'emulateDevice':
        await this.emulateDevice(message.tabId, message.device, message.requestId);
        break;
      
      case 'setUserAgent':
        await this.setUserAgent(message.tabId, message.userAgent, message.requestId);
        break;
      
      case 'getAllTabs':
        await this.getAllTabs(message.requestId);
        break;
      
      default:
        console.warn('Unknown action:', message.action);
    }
  }

  async getPageContent(tabId, requestId) {
    try {
      console.log('[DEBUG] getPageContent called with tabId:', tabId, 'type:', typeof tabId, 'requestId:', requestId);
      
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        console.log('[DEBUG] No tabId provided, getting active tab...');
        try {
          console.log('[DEBUG] Calling chrome.tabs.query...');
          // First try with currentWindow
          let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          console.log('[DEBUG] chrome.tabs.query with currentWindow returned:', tabs);
          
          // If no tabs found, try without currentWindow (service worker fallback)
          if (tabs.length === 0) {
            console.log('[DEBUG] No tabs with currentWindow, trying active tabs from all windows...');
            tabs = await chrome.tabs.query({ active: true });
            console.log('[DEBUG] chrome.tabs.query active from all windows returned:', tabs);
          }
          
          // If still no active tabs, get the last focused window's active tab
          if (tabs.length === 0) {
            console.log('[DEBUG] No active tabs found, trying last focused window...');
            const windows = await chrome.windows.getAll({ populate: true });
            console.log('[DEBUG] All windows:', windows);
            
            const focusedWindow = windows.find(w => w.focused) || windows[0];
            if (focusedWindow) {
              tabs = focusedWindow.tabs.filter(tab => tab.active);
              console.log('[DEBUG] Active tabs from focused window:', tabs);
            }
          }
          
          console.log('[DEBUG] All active tabs before filtering:', tabs);
          
          // Filter out chrome:// pages and other restricted URLs where content scripts can't run
          const validTabs = tabs.filter(tab => {
            const url = tab.url;
            const isValidPage = !url.startsWith('chrome://') && 
                               !url.startsWith('chrome-extension://') && 
                               !url.startsWith('edge://') && 
                               !url.startsWith('about:') &&
                               !url.startsWith('moz-extension://') &&
                               url !== 'chrome://newtab/';
            console.log('[DEBUG] Tab URL:', url, 'Valid for content scripts:', isValidPage);
            return isValidPage;
          });
          
          console.log('[DEBUG] Valid tabs after filtering:', validTabs);
          
          if (validTabs.length === 0) {
            throw new Error('No valid web pages found. Content scripts cannot run on chrome:// or extension pages. Please open a regular web page and try again.');
          }
          
          const [activeTab] = validTabs;
          console.log('[DEBUG] activeTab:', activeTab);
          
          if (!activeTab) {
            throw new Error('No active tab found in query result');
          }
          if (!activeTab.id) {
            throw new Error(`Active tab has no ID. Tab object: ${JSON.stringify(activeTab)}`);
          }
          
          tabId = activeTab.id;
          console.log('[DEBUG] Found active tab with ID:', tabId);
        } catch (error) {
          console.error('[DEBUG] Active tab detection failed:', error);
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      // Check if content script is loaded by getting tab info
      console.log('[DEBUG] Getting tab info before sending message...');
      const tab = await chrome.tabs.get(tabId);
      console.log('[DEBUG] Tab info:', { id: tab.id, url: tab.url, status: tab.status });
      
      console.log('[DEBUG] About to call chrome.tabs.sendMessage with tabId:', tabId, 'type:', typeof tabId);
      console.log('[DEBUG] tabId === undefined:', tabId === undefined);
      console.log('[DEBUG] tabId === null:', tabId === null);
      console.log('[DEBUG] Number.isInteger(tabId):', Number.isInteger(tabId));
      
      // Ensure tabId is valid
      if (!Number.isInteger(tabId) || tabId < 0) {
        throw new Error(`Invalid tabId: ${tabId} (type: ${typeof tabId})`);
      }
      
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, {
          action: 'getPageContent'
        });
        console.log('[DEBUG] chrome.tabs.sendMessage succeeded, response:', response);
      } catch (sendMessageError) {
        console.error('[DEBUG] chrome.tabs.sendMessage failed:', sendMessageError);
        
        // If content script not loaded, try to inject it programmatically
        if (sendMessageError.message.includes('Receiving end does not exist')) {
          console.log('[DEBUG] Content script not found, attempting programmatic injection...');
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['content.js']
            });
            console.log('[DEBUG] Content script injected successfully, retrying message...');
            
            // Wait a moment for script to initialize
            await new Promise(resolve => setTimeout(resolve, 100));
            
            console.log('[DEBUG] Retrying chrome.tabs.sendMessage with tabId:', tabId, 'type:', typeof tabId);
            if (!Number.isInteger(tabId) || tabId < 0) {
              throw new Error(`Invalid tabId for retry: ${tabId} (type: ${typeof tabId})`);
            }
            
            response = await chrome.tabs.sendMessage(tabId, {
              action: 'getPageContent'
            });
            console.log('[DEBUG] Retry succeeded after injection, response:', response);
          } catch (injectionError) {
            console.error('[DEBUG] Programmatic injection failed:', injectionError);
            throw new Error(`Content script not available and injection failed: ${injectionError.message}`);
          }
        } else {
          throw sendMessageError;
        }
      }
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getDOMSnapshot(tabId, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getDOMSnapshot'
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async executeScript(tabId, script, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'executeScript',
        script
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async attachDebugger(tabId, requestId) {
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
          requestId,
          data: { status: 'attached' }
        });
      }
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async detachDebugger(tabId, requestId) {
    try {
      if (this.debuggerAttached.has(tabId)) {
        await chrome.debugger.detach({ tabId });
        this.debuggerAttached.delete(tabId);
        
        this.sendToMCP({
          type: 'response',
          requestId,
          data: { status: 'detached' }
        });
      }
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getNetworkData(tabId, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }

      // Get stored network requests for this tab
      const networkData = this.getStoredNetworkRequests(tabId, 50);
      
      // Add summary statistics
      const requests = networkData.requests;
      networkData.summary = {
        totalRequests: requests.length,
        requestTypes: this.summarizeRequestTypes(requests),
        statusCodes: this.summarizeStatusCodes(requests),
        domains: this.summarizeDomains(requests),
        averageDuration: this.calculateAverageDuration(requests)
      };

      this.sendToMCP({
        type: 'response',
        requestId,
        data: networkData
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }
  
  summarizeRequestTypes(requests) {
    const types = {};
    requests.forEach(req => {
      types[req.type] = (types[req.type] || 0) + 1;
    });
    return types;
  }
  
  summarizeStatusCodes(requests) {
    const codes = {};
    requests.forEach(req => {
      if (req.statusCode) {
        codes[req.statusCode] = (codes[req.statusCode] || 0) + 1;
      }
    });
    return codes;
  }
  
  summarizeDomains(requests) {
    const domains = {};
    requests.forEach(req => {
      try {
        const domain = new URL(req.url).hostname;
        domains[domain] = (domains[domain] || 0) + 1;
      } catch (e) {
        // Ignore invalid URLs
      }
    });
    return domains;
  }
  
  calculateAverageDuration(requests) {
    const validDurations = requests.filter(req => req.duration > 0).map(req => req.duration);
    if (validDurations.length === 0) return 0;
    return Math.round(validDurations.reduce((a, b) => a + b, 0) / validDurations.length);
  }

  async getConsoleMessages(tabId, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'captureConsoleLog'
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async captureScreenshot(tabId, requestId) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: 'png',
        quality: 100
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: dataUrl
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getPerformanceMetrics(tabId, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getPerformanceMetrics'
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getAccessibilityTree(tabId, timeout, requestId) {
    try {
      // Get active tab if no tabId provided
      if (!tabId || tabId === null || tabId === undefined) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || !activeTab.id) {
            throw new Error('No active tab found');
          }
          tabId = activeTab.id;
        } catch (error) {
          throw new Error(`Failed to get active tab: ${error.message}`);
        }
      }
      
      const response = await chrome.tabs.sendMessage(tabId, {
        action: 'getAccessibilityTree',
        timeout: timeout
      });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: response
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getCookies(url, requestId) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      
      this.sendToMCP({
        type: 'response',
        requestId,
        data: cookies
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getStorageData(tabId, requestId) {
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
        requestId,
        data: {
          localStorage: localStorage[0].result,
          sessionStorage: sessionStorage[0].result
        }
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async emulateDevice(tabId, device, requestId) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await this.attachDebugger(tabId, requestId);
      }

      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setDeviceMetricsOverride',
        device
      );

      this.sendToMCP({
        type: 'response',
        requestId,
        data: { status: 'success' }
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async setUserAgent(tabId, userAgent, requestId) {
    try {
      if (!this.debuggerAttached.has(tabId)) {
        await this.attachDebugger(tabId, requestId);
      }

      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setUserAgentOverride',
        { userAgent }
      );

      this.sendToMCP({
        type: 'response',
        requestId,
        data: { status: 'success' }
      });
    } catch (error) {
      this.sendToMCP({
        type: 'error',
        requestId,
        error: error.message
      });
    }
  }

  async getAllTabs(requestId) {
    try {
      const tabs = await chrome.tabs.query({});
      
      this.sendToMCP({
        type: 'response',
        requestId,
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
        requestId,
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

  // Connection Health Monitoring Methods
  startHealthCheck() {
    console.log('[HEALTH] Starting periodic health checks every', this.healthCheckInterval / 1000, 'seconds');
    
    // Clear any existing health check timer
    this.stopHealthCheck();
    
    // Start periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      console.log('[HEALTH] Stopping health check timer');
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  performHealthCheck() {
    // Only perform health check if we think we're connected
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[HEALTH] WebSocket not open, skipping health check');
      return;
    }

    const now = Date.now();
    
    // Check if we've received a recent pong response
    if (this.lastPongReceived && (now - this.lastPongReceived) > this.healthCheckInterval * 1.5) {
      console.log('[HEALTH] No recent pong received, connection may be stale');
      this.handleHealthCheckFailure();
      return;
    }

    // Send ping to test connection
    try {
      console.log('[HEALTH] Sending ping to test connection health');
      this.sendToMCP({
        type: 'ping',
        timestamp: now
      });
      
      // Set timeout to detect if pong doesn't come back
      setTimeout(() => {
        if (this.lastPongReceived < now) {
          console.log('[HEALTH] Ping timeout - no pong received within', this.pingTimeout / 1000, 'seconds');
          this.handleHealthCheckFailure();
        }
      }, this.pingTimeout);
    } catch (error) {
      console.error('[HEALTH] Failed to send ping:', error);
      this.handleHealthCheckFailure();
    }
  }

  handleHealthCheckFailure() {
    this.consecutiveFailures++;
    console.log(`[HEALTH] Health check failure #${this.consecutiveFailures}`);
    
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      console.log('[HEALTH] Max consecutive failures reached, forcing reconnection');
      
      // Stop health check to avoid interfering with reconnection
      this.stopHealthCheck();
      
      // Force close the connection to trigger reconnection
      if (this.ws) {
        this.ws.close(1000, 'Health check failed');
      }
      
      // Reset failure counter and restart health check after reconnection
      this.consecutiveFailures = 0;
    }
  }

  // Network Monitoring Methods
  setupNetworkMonitoring() {
    console.log('[NETWORK] Setting up network request monitoring');
    
    // Track request start times and details
    const pendingRequests = new Map();
    
    // Listen for request start
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (details.tabId > 0) { // Only track requests from actual tabs
          const request = {
            requestId: details.requestId,
            tabId: details.tabId,
            url: details.url,
            method: details.method,
            type: details.type,
            timestamp: Date.now(),
            startTime: details.timeStamp
          };
          
          // Add request body for POST/PUT requests
          if (details.requestBody && (details.method === 'POST' || details.method === 'PUT')) {
            request.requestBody = this.parseRequestBody(details.requestBody);
          }
          
          pendingRequests.set(details.requestId, request);
        }
      },
      { urls: ['<all_urls>'] },
      ['requestBody']
    );
    
    // Listen for request headers
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const request = pendingRequests.get(details.requestId);
        if (request) {
          request.requestHeaders = details.requestHeaders;
        }
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );
    
    // Listen for response headers
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const request = pendingRequests.get(details.requestId);
        if (request) {
          request.statusCode = details.statusCode;
          request.statusLine = details.statusLine;
          request.responseHeaders = details.responseHeaders;
        }
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
    
    // Listen for request completion
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        const request = pendingRequests.get(details.requestId);
        if (request && details.tabId > 0) {
          // Complete the request data
          request.endTime = details.timeStamp;
          request.duration = details.timeStamp - request.startTime;
          request.fromCache = details.fromCache;
          request.statusCode = details.statusCode;
          request.ip = details.ip;
          
          // Store the completed request
          this.storeNetworkRequest(details.tabId, request);
        }
        pendingRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] }
    );
    
    // Listen for request errors
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        const request = pendingRequests.get(details.requestId);
        if (request && details.tabId > 0) {
          request.error = details.error;
          request.endTime = details.timeStamp;
          request.duration = details.timeStamp - request.startTime;
          
          this.storeNetworkRequest(details.tabId, request);
        }
        pendingRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] }
    );
    
    // Clean up network data when tabs are closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.networkRequests.delete(tabId);
    });
  }
  
  parseRequestBody(requestBody) {
    if (!requestBody) return null;
    
    try {
      if (requestBody.formData) {
        return { type: 'formData', data: requestBody.formData };
      } else if (requestBody.raw) {
        // Convert raw bytes to string for common content types
        const decoder = new TextDecoder();
        const data = requestBody.raw.map(item => {
          try {
            return decoder.decode(item.bytes);
          } catch (e) {
            return '[Binary data]';
          }
        }).join('');
        return { type: 'raw', data: data.substring(0, 1000) }; // Limit size
      }
    } catch (e) {
      console.warn('[NETWORK] Error parsing request body:', e);
    }
    return null;
  }
  
  storeNetworkRequest(tabId, request) {
    if (!this.networkRequests.has(tabId)) {
      this.networkRequests.set(tabId, []);
    }
    
    const requests = this.networkRequests.get(tabId);
    requests.push(request);
    
    // Keep only the most recent requests
    if (requests.length > this.maxRequestsPerTab) {
      requests.splice(0, requests.length - this.maxRequestsPerTab);
    }
    
    console.log(`[NETWORK] Stored request for tab ${tabId}: ${request.method} ${request.url}`);
  }
  
  getStoredNetworkRequests(tabId, limit = 50) {
    const requests = this.networkRequests.get(tabId) || [];
    
    // Return the most recent requests (up to limit)
    const recentRequests = requests.slice(-limit);
    
    return {
      requests: recentRequests,
      totalCount: requests.length,
      tabId: tabId,
      capturedAt: new Date().toISOString()
    };
  }
}

// Initialize the bridge
const bridge = new MCPBridge();