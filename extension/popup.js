// Popup UI controller

class PopupController {
  constructor() {
    this.port = null;
    this.isConnected = false;
    this.messagesSent = 0;
    this.messagesReceived = 0;
    
    this.initializeUI();
    this.setupCommunication();
    this.loadSettings();
  }

  initializeUI() {
    // Set version display
    this.setVersionDisplay();
    
    // Button event listeners
    document.getElementById('connect-btn').addEventListener('click', () => {
      this.toggleConnection();
    });

    document.getElementById('capture-current').addEventListener('click', () => {
      this.captureCurrentPage();
    });

    document.getElementById('open-devtools').addEventListener('click', () => {
      this.openDevTools();
    });

    document.getElementById('settings').addEventListener('click', () => {
      this.openSettings();
    });

    document.getElementById('server-url').addEventListener('change', (e) => {
      this.saveSettings();
    });
  }

  setupCommunication() {
    try {
      this.port = chrome.runtime.connect({ name: 'popup' });
      
      this.port.onMessage.addListener((message) => {
        this.handleMessage(message);
      });

      this.port.onDisconnect.addListener(() => {
        console.log('Popup disconnected from background');
      });

      // Request initial status
      this.requestStatus();
    } catch (error) {
      console.error('Failed to connect to background script:', error);
    }
  }

  handleMessage(message) {
    console.log('Popup received message:', message);
    
    switch (message.type) {
      case 'status':
        this.updateConnectionStatus(message.connected, message.url, message.reconnecting);
        break;
      
      case 'stats':
        this.updateStats(message.sent, message.received);
        break;
      
      case 'error':
        this.showError(message.error);
        break;
    }

    this.messagesReceived++;
    this.updateStats(this.messagesSent, this.messagesReceived);
  }

  requestStatus() {
    if (this.port) {
      this.port.postMessage({ action: 'getStatus' });
      this.messagesSent++;
    }
  }

  toggleConnection() {
    const serverUrl = document.getElementById('server-url').value;
    
    if (this.isConnected) {
      this.disconnect();
    } else {
      this.connect(serverUrl);
    }
  }

  connect(serverUrl) {
    if (this.port) {
      this.port.postMessage({ 
        action: 'connect',
        url: serverUrl
      });
      this.messagesSent++;
    }
  }

  disconnect() {
    if (this.port) {
      this.port.postMessage({ action: 'disconnect' });
      this.messagesSent++;
    }
  }

  updateConnectionStatus(connected, serverUrl, reconnecting = false) {
    this.isConnected = connected;
    
    const statusEl = document.getElementById('connection-status');
    const connectBtn = document.getElementById('connect-btn');
    const captureBtn = document.getElementById('capture-current');
    
    if (reconnecting) {
      statusEl.className = 'status reconnecting';
      statusEl.textContent = 'Reconnecting to MCP Server...';
      connectBtn.textContent = 'Reconnecting...';
      connectBtn.disabled = true;
      captureBtn.disabled = true;
    } else if (connected) {
      statusEl.className = 'status connected';
      statusEl.textContent = `Connected to ${serverUrl || 'MCP Server'}`;
      connectBtn.textContent = 'Disconnect';
      connectBtn.disabled = false;
      captureBtn.disabled = false;
    } else {
      statusEl.className = 'status disconnected';
      statusEl.textContent = 'Disconnected from MCP Server';
      connectBtn.textContent = 'Connect to Server';
      connectBtn.disabled = false;
      captureBtn.disabled = true;
    }
  }

  updateStats(sent, received) {
    document.getElementById('messages-sent').textContent = sent || this.messagesSent;
    document.getElementById('messages-received').textContent = received || this.messagesReceived;
  }

  async captureCurrentPage() {
    try {
      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (this.port) {
        this.port.postMessage({
          action: 'captureTab',
          tabId: tab.id
        });
        this.messagesSent++;
        
        this.showSuccess('Capturing current page data...');
      }
    } catch (error) {
      console.error('Error capturing current page:', error);
      this.showError('Failed to capture current page');
    }
  }

  openDevTools() {
    // This will be handled by the user manually opening DevTools
    // and navigating to our custom panel
    this.showInfo('Open Chrome DevTools and look for the "MCP Bridge" tab');
  }

  openSettings() {
    // Could open options page or show inline settings
    this.showInfo('Settings panel not yet implemented');
  }

  loadSettings() {
    chrome.storage.sync.get(['serverUrl'], (result) => {
      if (result.serverUrl) {
        document.getElementById('server-url').value = result.serverUrl;
      }
    });
  }

  saveSettings() {
    const serverUrl = document.getElementById('server-url').value;
    chrome.storage.sync.set({ serverUrl });
  }

  setVersionDisplay() {
    // Generate a timestamp-based version for easy visual tracking
    const now = new Date();
    const version = `v${now.getMonth() + 1}.${now.getDate()}.${now.getHours()}${now.getMinutes().toString().padStart(2, '0')}`;
    document.getElementById('version').textContent = version;
  }

  showError(message) {
    this.showNotification(message, 'error');
  }

  showSuccess(message) {
    this.showNotification(message, 'success');
  }

  showInfo(message) {
    this.showNotification(message, 'info');
  }

  showNotification(message, type) {
    // Simple toast notification
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 15px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 1000;
      max-width: 250px;
      word-wrap: break-word;
    `;
    
    switch (type) {
      case 'error':
        notification.style.background = '#ffebee';
        notification.style.color = '#c62828';
        notification.style.border = '1px solid #f44336';
        break;
      case 'success':
        notification.style.background = '#e8f5e8';
        notification.style.color = '#2e7d32';
        notification.style.border = '1px solid #4caf50';
        break;
      default:
        notification.style.background = '#e3f2fd';
        notification.style.color = '#1565c0';
        notification.style.border = '1px solid #2196f3';
    }
    
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.parentNode.removeChild(notification);
      }
    }, 3000);
  }
}

// Initialize popup when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});