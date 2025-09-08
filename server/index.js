#!/usr/bin/env node

/**
 * Browser MCP Server - Bridges browser extension data with Claude Code
 * 
 * This server implements the Model Context Protocol (MCP) to expose browser
 * data and capabilities to Claude Code through tools and resources.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

class BrowserMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "browser-mcp-bridge",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.browserConnections = new Map();
    this.browserData = new Map();
    this.wsServer = null;
    this.httpServer = null;
    
    this.setupMCPHandlers();
    this.setupWebSocketServer();
  }

  setupMCPHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_page_content",
            description: "Get the full content and metadata of a web page",
            inputSchema: {
              type: "object",
              properties: {
                tabId: {
                  type: "number",
                  description: "Browser tab ID (optional, uses active tab if not specified)"
                },
                includeMetadata: {
                  type: "boolean",
                  description: "Include page metadata like title, meta tags, etc.",
                  default: true
                }
              }
            }
          },
          {
            name: "get_dom_snapshot",
            description: "Get a structured snapshot of the DOM tree",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" },
                maxDepth: { type: "number", description: "Maximum DOM tree depth", default: 10 },
                includeStyles: { type: "boolean", description: "Include computed styles", default: false }
              }
            }
          },
          {
            name: "execute_javascript",
            description: "Execute JavaScript code in the browser page context",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" },
                code: { type: "string", description: "JavaScript code to execute" }
              },
              required: ["code"]
            }
          },
          {
            name: "get_console_messages",
            description: "Get console messages from the browser",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" },
                types: { 
                  type: "array", 
                  items: { type: "string" },
                  description: "Message types to include (log, error, warn, info, debug)"
                },
                limit: { type: "number", description: "Maximum number of messages", default: 100 }
              }
            }
          },
          {
            name: "get_network_requests",
            description: "Get network requests and responses from the browser",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" },
                limit: { type: "number", description: "Maximum number of requests", default: 50 }
              }
            }
          },
          {
            name: "capture_screenshot",
            description: "Capture a screenshot of the current browser tab",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" },
                format: { type: "string", enum: ["png", "jpeg"], default: "png" },
                quality: { type: "number", minimum: 0, maximum: 100, default: 90 }
              }
            }
          },
          {
            name: "get_performance_metrics",
            description: "Get performance metrics from the browser",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" }
              }
            }
          },
          {
            name: "get_accessibility_tree",
            description: "Get the accessibility tree of the page",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" }
              }
            }
          },
          {
            name: "get_browser_tabs",
            description: "Get information about all open browser tabs",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "attach_debugger",
            description: "Attach Chrome debugger to a tab for advanced inspection",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" }
              },
              required: ["tabId"]
            }
          },
          {
            name: "detach_debugger",
            description: "Detach Chrome debugger from a tab",
            inputSchema: {
              type: "object",
              properties: {
                tabId: { type: "number", description: "Browser tab ID" }
              },
              required: ["tabId"]
            }
          }
        ]
      };
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [];
      
      for (const [connectionId, data] of this.browserData.entries()) {
        if (data.pageContent) {
          resources.push({
            uri: `browser://tab/${data.tabId}/content`,
            name: `Page Content - ${data.pageContent.title || data.pageContent.url}`,
            description: `Full page content from ${data.pageContent.url}`,
            mimeType: "text/html"
          });
        }
        
        if (data.domSnapshot) {
          resources.push({
            uri: `browser://tab/${data.tabId}/dom`,
            name: `DOM Snapshot - ${data.domSnapshot.nodeCount} nodes`,
            description: `Structured DOM tree with ${data.domSnapshot.nodeCount} nodes`,
            mimeType: "application/json"
          });
        }
        
        if (data.consoleLogs && data.consoleLogs.length > 0) {
          resources.push({
            uri: `browser://tab/${data.tabId}/console`,
            name: `Console Messages - ${data.consoleLogs.length} messages`,
            description: `Console logs, errors, and warnings`,
            mimeType: "application/json"
          });
        }
      }
      
      return { resources };
    });

    // Read resource content
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^browser:\/\/tab\/(\d+)\/(content|dom|console)$/);
      
      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }
      
      const [, tabId, resourceType] = match;
      const data = Array.from(this.browserData.values()).find(d => d.tabId == tabId);
      
      if (!data) {
        throw new Error(`No data available for tab ${tabId}`);
      }
      
      switch (resourceType) {
        case 'content':
          return {
            contents: [
              {
                uri,
                mimeType: "text/html",
                text: data.pageContent?.html || ""
              }
            ]
          };
        
        case 'dom':
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(data.domSnapshot, null, 2)
              }
            ]
          };
        
        case 'console':
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(data.consoleLogs, null, 2)
              }
            ]
          };
        
        default:
          throw new Error(`Unknown resource type: ${resourceType}`);
      }
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      switch (name) {
        case "get_page_content":
          return await this.getPageContent(args?.tabId, args?.includeMetadata);
        
        case "get_dom_snapshot":
          return await this.getDOMSnapshot(args?.tabId, args?.maxDepth, args?.includeStyles);
        
        case "execute_javascript":
          return await this.executeJavaScript(args?.tabId, args.code);
        
        case "get_console_messages":
          return await this.getConsoleMessages(args?.tabId, args?.types, args?.limit);
        
        case "get_network_requests":
          return await this.getNetworkRequests(args?.tabId, args?.limit);
        
        case "capture_screenshot":
          return await this.captureScreenshot(args?.tabId, args?.format, args?.quality);
        
        case "get_performance_metrics":
          return await this.getPerformanceMetrics(args?.tabId);
        
        case "get_accessibility_tree":
          return await this.getAccessibilityTree(args?.tabId);
        
        case "get_browser_tabs":
          return await this.getBrowserTabs();
        
        case "attach_debugger":
          return await this.attachDebugger(args.tabId);
        
        case "detach_debugger":
          return await this.detachDebugger(args.tabId);
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  setupWebSocketServer() {
    const app = express();
    app.use(cors());
    app.use(express.json());
    
    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        connections: this.browserConnections.size,
        timestamp: new Date().toISOString(),
        port: this.port
      });
    });
    
    this.port = process.env.MCP_SERVER_PORT || 6009;
    this.httpServer = app.listen(this.port, () => {
      console.error(`MCP Bridge server listening on port ${this.port}`);
    });
    
    this.wsServer = new WebSocketServer({ 
      server: this.httpServer,
      path: '/mcp'
    });
    
    this.wsServer.on('connection', (ws, request) => {
      const connectionId = uuidv4();
      console.error(`Browser extension connected: ${connectionId}`);
      
      this.browserConnections.set(connectionId, {
        ws,
        id: connectionId,
        connectedAt: new Date(),
        lastActivity: new Date()
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleBrowserMessage(connectionId, message);
        } catch (error) {
          console.error('Error parsing browser message:', error);
        }
      });
      
      ws.on('close', () => {
        console.error(`Browser extension disconnected: ${connectionId}`);
        this.browserConnections.delete(connectionId);
        this.browserData.delete(connectionId);
      });
      
      ws.on('error', (error) => {
        console.error(`WebSocket error for ${connectionId}:`, error);
      });
    });
  }

  handleBrowserMessage(connectionId, message) {
    const connection = this.browserConnections.get(connectionId);
    if (!connection) return;
    
    connection.lastActivity = new Date();
    
    switch (message.type) {
      case 'browser-data':
        this.storeBrowserData(connectionId, message);
        break;
      
      case 'response':
        this.handleBrowserResponse(connectionId, message);
        break;
      
      case 'error':
        this.handleBrowserError(connectionId, message);
        break;
      
      default:
        console.error(`Unknown message type: ${message.type}`);
    }
  }

  storeBrowserData(connectionId, message) {
    if (!this.browserData.has(connectionId)) {
      this.browserData.set(connectionId, {});
    }
    
    const data = this.browserData.get(connectionId);
    
    switch (message.source) {
      case 'content-script':
        if (message.data) {
          Object.assign(data, message.data);
          data.tabId = message.tabId;
          data.url = message.url;
          data.lastUpdated = new Date();
        }
        break;
      
      case 'devtools':
        data.devToolsData = message.data;
        break;
      
      case 'debugger':
        if (!data.debuggerEvents) data.debuggerEvents = [];
        data.debuggerEvents.push({
          method: message.method,
          params: message.params,
          timestamp: message.timestamp
        });
        // Keep only last 100 events
        if (data.debuggerEvents.length > 100) {
          data.debuggerEvents = data.debuggerEvents.slice(-100);
        }
        break;
    }
  }

  handleBrowserResponse(connectionId, message) {
    // Store the response data
    if (!this.browserData.has(connectionId)) {
      this.browserData.set(connectionId, {});
    }
    
    const data = this.browserData.get(connectionId);
    
    switch (message.action) {
      case 'getPageContent':
        data.pageContent = message.data;
        break;
      case 'getDOMSnapshot':
        data.domSnapshot = message.data;
        break;
      case 'getConsoleMessages':
        data.consoleLogs = message.data;
        break;
      case 'getNetworkData':
        data.networkData = message.data;
        break;
      case 'captureScreenshot':
        data.screenshot = message.data;
        break;
      case 'getPerformanceMetrics':
        data.performanceMetrics = message.data;
        break;
    }
  }

  handleBrowserError(connectionId, message) {
    console.error(`Browser error in ${connectionId}:`, message.error);
  }

  // MCP Tool implementations
  async sendToBrowser(action, params = {}) {
    if (this.browserConnections.size === 0) {
      throw new Error('No browser extensions connected');
    }
    
    const connection = Array.from(this.browserConnections.values())[0];
    
    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      const timeout = setTimeout(() => {
        reject(new Error('Browser request timeout'));
      }, 10000);
      
      const responseHandler = (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'response' && message.requestId === requestId) {
            clearTimeout(timeout);
            connection.ws.off('message', responseHandler);
            resolve(message.data);
          } else if (message.type === 'error' && message.requestId === requestId) {
            clearTimeout(timeout);
            connection.ws.off('message', responseHandler);
            reject(new Error(message.error));
          }
        } catch (error) {
          // Ignore parsing errors for other messages
        }
      };
      
      connection.ws.on('message', responseHandler);
      connection.ws.send(JSON.stringify({
        action,
        requestId,
        ...params
      }));
    });
  }

  async getPageContent(tabId, includeMetadata = true) {
    try {
      await this.sendToBrowser('getPageContent', { tabId });
      
      // Return cached data
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.pageContent) {
        throw new Error('No page content available');
      }
      
      const result = {
        url: data.pageContent.url,
        title: data.pageContent.title,
        text: data.pageContent.text,
        html: includeMetadata ? data.pageContent.html : undefined,
        metadata: includeMetadata ? data.pageContent.metadata : undefined
      };
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get page content: ${error.message}`);
    }
  }

  async getDOMSnapshot(tabId, maxDepth = 10, includeStyles = false) {
    try {
      await this.sendToBrowser('getDOMSnapshot', { tabId });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.domSnapshot) {
        throw new Error('No DOM snapshot available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.domSnapshot, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get DOM snapshot: ${error.message}`);
    }
  }

  async executeJavaScript(tabId, code) {
    try {
      const result = await this.sendToBrowser('executeScript', { tabId, script: code });
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to execute JavaScript: ${error.message}`);
    }
  }

  async getConsoleMessages(tabId, types, limit = 100) {
    try {
      await this.sendToBrowser('getConsoleMessages', { tabId });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.consoleLogs) {
        throw new Error('No console messages available');
      }
      
      let messages = data.consoleLogs;
      
      if (types && types.length > 0) {
        messages = messages.filter(msg => types.includes(msg.type));
      }
      
      messages = messages.slice(-limit);
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ messages, count: messages.length }, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get console messages: ${error.message}`);
    }
  }

  async getNetworkRequests(tabId, limit = 50) {
    try {
      await this.sendToBrowser('getNetworkData', { tabId });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.networkData) {
        throw new Error('No network data available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.networkData, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get network requests: ${error.message}`);
    }
  }

  async captureScreenshot(tabId, format = 'png', quality = 90) {
    try {
      await this.sendToBrowser('captureScreenshot', { tabId, format, quality });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.screenshot) {
        throw new Error('No screenshot available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Screenshot captured in ${format} format. Data URL: ${data.screenshot.substring(0, 100)}...`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to capture screenshot: ${error.message}`);
    }
  }

  async getPerformanceMetrics(tabId) {
    try {
      await this.sendToBrowser('getPerformanceMetrics', { tabId });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.performanceMetrics) {
        throw new Error('No performance metrics available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.performanceMetrics, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get performance metrics: ${error.message}`);
    }
  }

  async getAccessibilityTree(tabId) {
    try {
      await this.sendToBrowser('getAccessibilityTree', { tabId });
      
      const data = Array.from(this.browserData.values()).find(d => 
        !tabId || d.tabId == tabId
      );
      
      if (!data?.accessibilityTree) {
        throw new Error('No accessibility tree available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.accessibilityTree, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get accessibility tree: ${error.message}`);
    }
  }

  async getBrowserTabs() {
    try {
      await this.sendToBrowser('getAllTabs');
      
      const data = Array.from(this.browserData.values())[0];
      
      if (!data?.tabs) {
        throw new Error('No tab information available');
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data.tabs, null, 2)
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to get browser tabs: ${error.message}`);
    }
  }

  async attachDebugger(tabId) {
    try {
      await this.sendToBrowser('attachDebugger', { tabId });
      
      return {
        content: [
          {
            type: "text",
            text: `Debugger attached to tab ${tabId}`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to attach debugger: ${error.message}`);
    }
  }

  async detachDebugger(tabId) {
    try {
      await this.sendToBrowser('detachDebugger', { tabId });
      
      return {
        content: [
          {
            type: "text",
            text: `Debugger detached from tab ${tabId}`
          }
        ]
      };
    } catch (error) {
      throw new Error(`Failed to detach debugger: ${error.message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Browser MCP Bridge Server running on stdio");
  }
}

// Start the server
const server = new BrowserMCPServer();
server.run().catch(console.error);