// DevTools panel UI controller

class PanelController {
  constructor() {
    this.port = null;
    this.tabId = chrome.devtools.inspectedWindow.tabId;
    this.isConnected = false;
    
    this.initializeUI();
    this.setupCommunication();
    this.startMonitoring();
  }

  initializeUI() {
    // Button event listeners
    document.getElementById('reconnect-btn').addEventListener('click', () => {
      this.reconnect();
    });

    document.getElementById('capture-page').addEventListener('click', () => {
      this.sendAction('getPageContent');
    });

    document.getElementById('capture-dom').addEventListener('click', () => {
      this.sendAction('getDOMSnapshot');
    });

    document.getElementById('capture-console').addEventListener('click', () => {
      this.sendAction('getConsoleMessages');
    });

    document.getElementById('capture-network').addEventListener('click', () => {
      this.sendAction('getNetworkData');
    });

    document.getElementById('capture-performance').addEventListener('click', () => {
      this.sendAction('getPerformanceMetrics');
    });

    document.getElementById('capture-screenshot').addEventListener('click', () => {
      this.sendAction('captureScreenshot');
    });

    document.getElementById('clear-data').addEventListener('click', () => {
      this.clearAllData();
    });

    this.updatePageInfo();
  }

  setupCommunication() {
    try {
      this.port = chrome.runtime.connect({ name: 'devtools-panel' });
      
      this.port.onMessage.addListener((message) => {
        this.handleMessage(message);
      });

      this.port.onDisconnect.addListener(() => {
        this.updateConnectionStatus(false);
      });

      this.updateConnectionStatus(true);
    } catch (error) {
      console.error('Failed to connect to background script:', error);
      this.updateConnectionStatus(false);
    }
  }

  handleMessage(message) {
    console.log('Panel received message:', message);
    
    switch (message.type) {
      case 'mcp-status':
        this.updateConnectionStatus(message.connected);
        break;
      
      case 'response':
        this.handleResponse(message);
        break;
      
      case 'error':
        this.handleError(message);
        break;
      
      case 'console-data':
        this.updateConsoleMessages(message.data);
        break;
      
      case 'network-data':
        this.updateNetworkActivity(message.data);
        break;
    }
  }

  handleResponse(message) {
    this.addMCPMessage(`✓ ${message.action} completed`, 'success');
    
    switch (message.action) {
      case 'getPageContent':
        this.displayPageContent(message.data);
        break;
      
      case 'getDOMSnapshot':
        this.displayDOMSnapshot(message.data);
        break;
      
      case 'getConsoleMessages':
        this.updateConsoleMessages(message.data);
        break;
      
      case 'getNetworkData':
        this.updateNetworkActivity(message.data);
        break;
      
      case 'getPerformanceMetrics':
        this.displayPerformanceMetrics(message.data);
        break;
      
      case 'captureScreenshot':
        this.displayScreenshot(message.data);
        break;
    }
  }

  handleError(message) {
    this.addMCPMessage(`✗ ${message.action} failed: ${message.error}`, 'error');
  }

  sendAction(action, params = {}) {
    if (this.port) {
      this.port.postMessage({
        type: 'action',
        action,
        tabId: this.tabId,
        ...params
      });
      
      this.addMCPMessage(`→ Sent ${action}`, 'info');
    } else {
      this.addMCPMessage('No connection to background script', 'error');
    }
  }

  updateConnectionStatus(connected) {
    this.isConnected = connected;
    const indicator = document.getElementById('status-indicator');
    const text = document.getElementById('status-text');
    
    if (connected) {
      indicator.className = 'status-indicator connected';
      text.textContent = 'Connected to MCP Server';
    } else {
      indicator.className = 'status-indicator disconnected';
      text.textContent = 'Disconnected from MCP Server';
    }
    
    // Enable/disable action buttons
    const buttons = document.querySelectorAll('.button:not(#reconnect-btn)');
    buttons.forEach(btn => {
      btn.disabled = !connected;
    });
  }

  addMCPMessage(message, type = 'info') {
    const container = document.getElementById('mcp-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `data-item ${type}`;
    messageEl.innerHTML = `<strong>${new Date().toLocaleTimeString()}</strong> ${message}`;
    
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
    
    // Keep only last 50 messages
    while (container.children.length > 50) {
      container.removeChild(container.firstChild);
    }
  }

  updatePageInfo() {
    chrome.devtools.inspectedWindow.eval(
      'window.location.href',
      (url) => {
        document.getElementById('page-url').textContent = url;
      }
    );
    
    chrome.devtools.inspectedWindow.eval(
      'document.title',
      (title) => {
        document.getElementById('page-title').textContent = title;
      }
    );
    
    document.getElementById('last-updated').textContent = new Date().toLocaleString();
  }

  displayPageContent(data) {
    this.addMCPMessage(`Page content captured: ${data.text?.length || 0} characters`, 'success');
  }

  displayDOMSnapshot(data) {
    this.addMCPMessage(`DOM snapshot captured: ${data.nodeCount || 0} nodes`, 'success');
  }

  updateConsoleMessages(logs) {
    const container = document.getElementById('console-messages');
    container.innerHTML = '';
    
    if (!logs || logs.length === 0) {
      container.textContent = 'No console messages';
      return;
    }
    
    logs.slice(-20).forEach(log => { // Show last 20 messages
      const logEl = document.createElement('div');
      logEl.className = `data-item ${log.type}`;
      logEl.innerHTML = `
        <strong>[${log.type.toUpperCase()}]</strong> 
        ${new Date(log.timestamp).toLocaleTimeString()}<br>
        <pre>${log.message}</pre>
      `;
      container.appendChild(logEl);
    });
  }

  updateNetworkActivity(data) {
    const container = document.getElementById('network-activity');
    container.innerHTML = '';
    
    if (!data || !data.entries || data.entries.length === 0) {
      container.textContent = 'No network activity';
      return;
    }
    
    data.entries.slice(-10).forEach(entry => { // Show last 10 requests
      const reqEl = document.createElement('div');
      reqEl.className = 'data-item';
      reqEl.innerHTML = `
        <strong>${entry.request.method}</strong> 
        ${entry.response.status} ${entry.request.url}<br>
        <small>Time: ${entry.time}ms | Size: ${entry.response.content.size || 0} bytes</small>
      `;
      container.appendChild(reqEl);
    });
  }

  displayPerformanceMetrics(data) {
    this.addMCPMessage(`Performance metrics: Load time ${data.timing?.loadTime}ms`, 'success');
  }

  displayScreenshot(dataUrl) {
    this.addMCPMessage('Screenshot captured', 'success');
    
    // Could display thumbnail or save to downloads
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.maxWidth = '200px';
    img.style.maxHeight = '150px';
    img.style.border = '1px solid #ccc';
    img.style.borderRadius = '4px';
    
    const container = document.getElementById('mcp-messages');
    const messageEl = document.createElement('div');
    messageEl.className = 'data-item success';
    messageEl.innerHTML = '<strong>Screenshot:</strong><br>';
    messageEl.appendChild(img);
    
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
  }

  clearAllData() {
    document.getElementById('mcp-messages').innerHTML = '';
    document.getElementById('console-messages').innerHTML = 'No console messages captured';
    document.getElementById('network-activity').innerHTML = 'No network activity captured';
    this.addMCPMessage('Data cleared', 'info');
  }

  reconnect() {
    this.setupCommunication();
    this.addMCPMessage('Attempting to reconnect...', 'info');
  }

  startMonitoring() {
    // Update page info periodically
    setInterval(() => {
      this.updatePageInfo();
    }, 5000);
    
    // Check connection status
    setInterval(() => {
      if (this.port) {
        this.port.postMessage({ type: 'ping' });
      }
    }, 10000);
  }
}

// Initialize the panel controller
const panelController = new PanelController();