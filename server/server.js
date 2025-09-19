#!/usr/bin/env node

/**
 * Browser MCP Server - HTTP Streamable Transport
 *
 * This server implements the Model Context Protocol (MCP) using HTTP streamable
 * transport instead of stdio, allowing multiple Claude Code instances to connect
 * to the same server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { WebSocketServer } from "ws";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

class BrowserMCPHttpServer {
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
			},
		);

		this.browserConnections = new Map();
		this.browserData = new Map();
		this.wsServer = null;
		this.httpServer = null;
		this.port = 6009;

		this.setupMCPHandlers();
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
									description:
										"Browser tab ID (optional, uses active tab if not specified)",
								},
								includeMetadata: {
									type: "boolean",
									description:
										"Include page metadata like title, meta tags, etc.",
									default: true,
								},
							},
						},
					},
					{
						name: "get_dom_snapshot",
						description: "Get a structured snapshot of the DOM tree",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								maxDepth: {
									type: "number",
									description: "Maximum DOM tree depth",
									default: 10,
								},
								includeStyles: {
									type: "boolean",
									description: "Include computed styles",
									default: false,
								},
							},
						},
					},
					{
						name: "execute_javascript",
						description: "Execute JavaScript code in the browser page context",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								code: {
									type: "string",
									description: "JavaScript code to execute",
								},
							},
							required: ["code"],
						},
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
									description:
										"Message types to include (log, error, warn, info, debug)",
								},
								limit: {
									type: "number",
									description: "Maximum number of messages",
									default: 100,
								},
							},
						},
					},
					{
						name: "get_network_requests",
						description: "Get network requests and responses from the browser",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								limit: {
									type: "number",
									description: "Maximum number of requests",
									default: 50,
								},
							},
						},
					},
					{
						name: "capture_screenshot",
						description: "Capture a screenshot of the current browser tab",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								format: {
									type: "string",
									enum: ["png", "jpeg"],
									default: "png",
								},
								quality: {
									type: "number",
									minimum: 0,
									maximum: 100,
									default: 90,
								},
							},
						},
					},
					{
						name: "get_performance_metrics",
						description: "Get performance metrics from the browser",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
							},
						},
					},
					{
						name: "get_accessibility_tree",
						description: "Get the accessibility tree of the page",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
							},
						},
					},
					{
						name: "get_browser_tabs",
						description: "Get information about all open browser tabs",
						inputSchema: {
							type: "object",
							properties: {},
						},
					},
					{
						name: "attach_debugger",
						description:
							"Attach Chrome debugger to a tab for advanced inspection",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
							},
							required: ["tabId"],
						},
					},
					{
						name: "detach_debugger",
						description: "Detach Chrome debugger from a tab",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
							},
							required: ["tabId"],
						},
					},
				],
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
						mimeType: "text/html",
					});
				}

				if (data.domSnapshot) {
					resources.push({
						uri: `browser://tab/${data.tabId}/dom`,
						name: `DOM Snapshot - ${data.domSnapshot.nodeCount} nodes`,
						description: `Structured DOM tree with ${data.domSnapshot.nodeCount} nodes`,
						mimeType: "application/json",
					});
				}

				if (data.consoleLogs && data.consoleLogs.length > 0) {
					resources.push({
						uri: `browser://tab/${data.tabId}/console`,
						name: `Console Messages - ${data.consoleLogs.length} messages`,
						description: `Console logs, errors, and warnings`,
						mimeType: "application/json",
					});
				}
			}

			return { resources };
		});

		// Read resource content
		this.server.setRequestHandler(
			ReadResourceRequestSchema,
			async (request) => {
				const uri = request.params.uri;
				const match = uri.match(
					/^browser:\/\/tab\/(\d+)\/(content|dom|console)$/,
				);

				if (!match) {
					throw new Error(`Invalid resource URI: ${uri}`);
				}

				const [, tabId, resourceType] = match;
				const data = Array.from(this.browserData.values()).find(
					(d) => d.tabId == tabId,
				);

				if (!data) {
					throw new Error(`No data available for tab ${tabId}`);
				}

				switch (resourceType) {
					case "content":
						return {
							contents: [
								{
									uri,
									mimeType: "text/html",
									text: data.pageContent?.html || "",
								},
							],
						};

					case "dom":
						return {
							contents: [
								{
									uri,
									mimeType: "application/json",
									text: JSON.stringify(data.domSnapshot, null, 2),
								},
							],
						};

					case "console":
						return {
							contents: [
								{
									uri,
									mimeType: "application/json",
									text: JSON.stringify(data.consoleLogs, null, 2),
								},
							],
						};

					default:
						throw new Error(`Unknown resource type: ${resourceType}`);
				}
			},
		);

		// Handle tool calls
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;

			switch (name) {
				case "get_page_content":
					return await this.getPageContent(args?.tabId, args?.includeMetadata);

				case "get_dom_snapshot":
					return await this.getDOMSnapshot(
						args?.tabId,
						args?.maxDepth,
						args?.includeStyles,
					);

				case "execute_javascript":
					return await this.executeJavaScript(args?.tabId, args.code);

				case "get_console_messages":
					return await this.getConsoleMessages(
						args?.tabId,
						args?.types,
						args?.limit,
					);

				case "get_network_requests":
					return await this.getNetworkRequests(args?.tabId, args?.limit);

				case "capture_screenshot":
					return await this.captureScreenshot(
						args?.tabId,
						args?.format,
						args?.quality,
					);

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

	// Direct handler methods for HTTP MCP transport
	async handleInitialize(params) {
		console.error("Handling initialize request:", JSON.stringify(params, null, 2));
		
		return {
			protocolVersion: "2025-06-18",
			serverInfo: {
				name: "browser-mcp-bridge",
				version: "1.0.0"
			},
			capabilities: {
				tools: {},
				resources: {}
			}
		};
	}

	async handleToolsList() {
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
								description:
									"Browser tab ID (optional, uses active tab if not specified)",
							},
							includeMetadata: {
								type: "boolean",
								description:
									"Include page metadata like title, meta tags, etc.",
								default: true,
							},
						},
					},
				},
				{
					name: "get_dom_snapshot",
					description: "Get a structured snapshot of the DOM tree",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							maxDepth: {
								type: "number",
								description: "Maximum DOM tree depth",
								default: 10,
							},
							includeStyles: {
								type: "boolean",
								description: "Include computed styles",
								default: false,
							},
						},
					},
				},
				{
					name: "execute_javascript",
					description: "Execute JavaScript code in the browser page context",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							code: {
								type: "string",
								description: "JavaScript code to execute",
							},
						},
						required: ["code"],
					},
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
								description:
									"Message types to include (log, error, warn, info, debug)",
							},
							limit: {
								type: "number",
								description: "Maximum number of messages",
								default: 100,
							},
						},
					},
				},
				{
					name: "get_network_requests",
					description: "Get network requests and responses from the browser",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							limit: {
								type: "number",
								description: "Maximum number of requests",
								default: 50,
							},
						},
					},
				},
				{
					name: "capture_screenshot",
					description: "Capture a screenshot of the current browser tab",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							format: {
								type: "string",
								enum: ["png", "jpeg"],
								default: "png",
							},
							quality: {
								type: "number",
								minimum: 0,
								maximum: 100,
								default: 90,
							},
						},
					},
				},
				{
					name: "get_performance_metrics",
					description: "Get performance metrics from the browser",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
						},
					},
				},
				{
					name: "get_accessibility_tree",
					description: "Get the accessibility tree of the page",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							timeout: { 
								type: "number", 
								description: "Timeout in milliseconds (default: 30000, max: 120000)",
								default: 30000,
								minimum: 5000,
								maximum: 120000
							},
						},
					},
				},
				{
					name: "get_browser_tabs",
					description: "Get information about all open browser tabs",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "attach_debugger",
					description:
						"Attach Chrome debugger to a tab for advanced inspection",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
						},
						required: ["tabId"],
					},
				},
				{
					name: "detach_debugger",
					description: "Detach Chrome debugger from a tab",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
						},
						required: ["tabId"],
					},
				},
			],
		};
	}

	async handleResourcesList() {
		const resources = [];

		for (const [connectionId, data] of this.browserData.entries()) {
			if (data.pageContent) {
				resources.push({
					uri: `browser://tab/${data.tabId}/content`,
					name: `Page Content - ${data.pageContent.title || data.pageContent.url}`,
					description: `Full page content from ${data.pageContent.url}`,
					mimeType: "text/html",
				});
			}

			if (data.domSnapshot) {
				resources.push({
					uri: `browser://tab/${data.tabId}/dom`,
					name: `DOM Snapshot - ${data.domSnapshot.nodeCount} nodes`,
					description: `Structured DOM tree with ${data.domSnapshot.nodeCount} nodes`,
					mimeType: "application/json",
				});
			}

			if (data.consoleLogs && data.consoleLogs.length > 0) {
				resources.push({
					uri: `browser://tab/${data.tabId}/console`,
					name: `Console Messages - ${data.consoleLogs.length} messages`,
					description: `Console logs, errors, and warnings`,
					mimeType: "application/json",
				});
			}
		}

		return { resources };
	}

	async handleResourceRead(params) {
		const uri = params.uri;
		const match = uri.match(
			/^browser:\/\/tab\/(\d+)\/(content|dom|console)$/,
		);

		if (!match) {
			throw new Error(`Invalid resource URI: ${uri}`);
		}

		const [, tabId, resourceType] = match;
		const data = Array.from(this.browserData.values()).find(
			(d) => d.tabId == tabId,
		);

		if (!data) {
			throw new Error(`No data available for tab ${tabId}`);
		}

		switch (resourceType) {
			case "content":
				return {
					contents: [
						{
							uri,
							mimeType: "text/html",
							text: data.pageContent?.html || "",
						},
					],
				};

			case "dom":
				return {
					contents: [
						{
							uri,
							mimeType: "application/json",
							text: JSON.stringify(data.domSnapshot, null, 2),
						},
					],
				};

			case "console":
				return {
					contents: [
						{
							uri,
							mimeType: "application/json",
							text: JSON.stringify(data.consoleLogs, null, 2),
						},
					],
				};

			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	async handleToolCall(params) {
		const { name, arguments: args } = params;

		switch (name) {
			case "get_page_content":
				return await this.getPageContent(args?.tabId, args?.includeMetadata);

			case "get_dom_snapshot":
				return await this.getDOMSnapshot(
					args?.tabId,
					args?.maxDepth,
					args?.includeStyles,
				);

			case "execute_javascript":
				return await this.executeJavaScript(args?.tabId, args.code);

			case "get_console_messages":
				return await this.getConsoleMessages(
					args?.tabId,
					args?.types,
					args?.limit,
				);

			case "get_network_requests":
				return await this.getNetworkRequests(args?.tabId, args?.limit);

			case "capture_screenshot":
				return await this.captureScreenshot(
					args?.tabId,
					args?.format,
					args?.quality,
				);

			case "get_performance_metrics":
				return await this.getPerformanceMetrics(args?.tabId);

			case "get_accessibility_tree":
				return await this.getAccessibilityTree(args?.tabId, args?.timeout);

			case "get_browser_tabs":
				return await this.getBrowserTabs();

			case "attach_debugger":
				return await this.attachDebugger(args.tabId);

			case "detach_debugger":
				return await this.detachDebugger(args.tabId);

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}

	async setupHttpServer() {
		const app = express();

		// Enable CORS for all routes
		app.use(
			cors({
				origin: "*",
				methods: ["GET", "POST", "OPTIONS"],
				headers: ["Content-Type", "Authorization"],
			}),
		);

		app.use(express.json());

		// Health check endpoint
		app.get("/health", (req, res) => {
			res.json({
				status: "ok",
				connections: this.browserConnections.size,
				timestamp: new Date().toISOString(),
				port: this.port,
				transport: "http-streamable",
			});
		});

		// MCP HTTP streamable endpoint
		app.post("/mcp", async (req, res) => {
			try {
				// Set headers for streaming response
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-cache");
				res.setHeader("Connection", "keep-alive");

				const request = req.body;
				
				// Debug logging
				console.error("Received MCP request:", JSON.stringify(request, null, 2));

				// Validate request format
				if (!request || typeof request !== 'object') {
					throw new Error("Invalid request format");
				}

				if (!request.method) {
					throw new Error(`Missing method field. Received: ${JSON.stringify(request)}`);
				}

				// Handle MCP JSON-RPC requests manually
				let response;
				
				switch (request.method) {
					case "initialize":
						response = await this.handleInitialize(request.params);
						break;
					case "notifications/initialized":
						// This is a notification, no response needed
						console.error("Client initialized successfully");
						res.status(200).end();
						return;
					case "tools/list":
						response = await this.handleToolsList();
						break;
					case "resources/list":
						response = await this.handleResourcesList();
						break;
					case "resources/read":
						response = await this.handleResourceRead(request.params);
						break;
					case "tools/call":
						response = await this.handleToolCall(request.params);
						break;
					default:
						throw new Error(`Unknown method: ${request.method}`);
				}

				// Wrap response in JSON-RPC format
				const jsonRpcResponse = {
					jsonrpc: "2.0",
					id: request.id,
					result: response
				};

				console.error("Sending MCP response:", JSON.stringify(jsonRpcResponse, null, 2));
				res.json(jsonRpcResponse);
			} catch (error) {
				console.error("MCP request error:", error);
				console.error("Request body was:", JSON.stringify(req.body, null, 2));
				
				// Return JSON-RPC error format
				res.json({
					jsonrpc: "2.0",
					id: req.body?.id || null,
					error: {
						code: -32603,
						message: "Internal error",
						data: error.message,
					},
				});
			}
		});

		// Add cleanup endpoint for debugging connection issues
		app.post('/cleanup-connections', (req, res) => {
			console.log('Manual connection cleanup requested');
			this.cleanupStaleConnections();
			res.json({ 
				message: 'Connection cleanup completed',
				activeConnections: this.browserConnections.size 
			});
		});

		// Start HTTP server
		this.httpServer = app.listen(this.port, () => {
			console.error(`MCP HTTP server listening on port ${this.port}`);
			console.error(`MCP endpoint: http://localhost:${this.port}/mcp`);
			console.error(`WebSocket endpoint: ws://localhost:${this.port}/ws`);
			console.error(`Connection cleanup: POST http://localhost:${this.port}/cleanup-connections`);
		});

		// Set up WebSocket server for browser extension connections
		this.wsServer = new WebSocketServer({
			server: this.httpServer,
			path: "/ws",
		});

		this.wsServer.on("connection", (ws) => {
			const connectionId = uuidv4();
			console.error(`Browser extension connected: ${connectionId}`);

			this.browserConnections.set(connectionId, {
				ws,
				id: connectionId,
				connectedAt: new Date(),
				lastActivity: new Date(),
			});

			ws.on("message", (data) => {
				try {
					const message = JSON.parse(data.toString());
					this.handleBrowserMessage(connectionId, message);
				} catch (error) {
					console.error("Error parsing browser message:", error);
				}
			});

			ws.on("close", () => {
				console.error(`Browser extension disconnected: ${connectionId}`);
				this.browserConnections.delete(connectionId);
				this.browserData.delete(connectionId);
			});

			ws.on("error", (error) => {
				console.error(`WebSocket error for ${connectionId}:`, error);
			});
		});

		// Periodic cleanup of stale connections every 30 seconds  
		setInterval(() => {
			this.cleanupStaleConnections();
		}, 30000);
	}

	handleBrowserMessage(connectionId, message) {
		const connection = this.browserConnections.get(connectionId);
		if (!connection) return;

		connection.lastActivity = new Date();
		
		// Debug logging to see exactly what message we're receiving
		console.error(`[DEBUG] Received message from ${connectionId}:`, JSON.stringify(message, null, 2));
		console.error(`[DEBUG] Message type: "${message.type}" (type: ${typeof message.type})`);

		// Handle connection messages with more flexible matching
		if (message.type === "connection" || (message.type && message.type.toLowerCase().includes("connection"))) {
			console.error(`Browser extension connection established: ${connectionId}`);
			return;
		}

		switch (message.type) {
			case "connection":
				console.error(`Browser extension connection established: ${connectionId}`);
				break;

			case "ping":
				// Respond to health check ping with pong
				console.error(`[HEALTH] Received ping from ${connectionId}, sending pong`);
				this.sendDirectMessageToBrowser(connectionId, {
					type: 'pong',
					timestamp: Date.now(),
					originalTimestamp: message.timestamp
				});
				break;

			case "browser-data":
				this.storeBrowserData(connectionId, message);
				break;

			case "response":
				this.handleBrowserResponse(connectionId, message);
				break;

			case "error":
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
			case "content-script":
				if (message.data) {
					Object.assign(data, message.data);
					data.tabId = message.tabId;
					data.url = message.url;
					data.lastUpdated = new Date();
				}
				break;

			case "devtools":
				data.devToolsData = message.data;
				break;

			case "debugger":
				if (!data.debuggerEvents) data.debuggerEvents = [];
				data.debuggerEvents.push({
					method: message.method,
					params: message.params,
					timestamp: message.timestamp,
				});
				// Keep only last 100 events
				if (data.debuggerEvents.length > 100) {
					data.debuggerEvents = data.debuggerEvents.slice(-100);
				}
				break;
		}
	}

	handleBrowserResponse(connectionId, message) {
		if (!this.browserData.has(connectionId)) {
			this.browserData.set(connectionId, {});
		}

		const data = this.browserData.get(connectionId);

		switch (message.action) {
			case "getPageContent":
				data.pageContent = message.data;
				break;
			case "getDOMSnapshot":
				data.domSnapshot = message.data;
				break;
			case "getConsoleMessages":
				data.consoleLogs = message.data;
				break;
			case "getNetworkData":
				data.networkData = message.data;
				break;
			case "captureScreenshot":
				data.screenshot = message.data;
				break;
			case "getPerformanceMetrics":
				data.performanceMetrics = message.data;
				break;
		}
	}

	handleBrowserError(connectionId, message) {
		console.error(`Browser error in ${connectionId}:`, message.error);
	}

	cleanupStaleConnections() {
		const staleTimeout = 30000; // 30 seconds
		const now = Date.now();
		
		for (const [connectionId, connection] of this.browserConnections) {
			// Remove connections that are closed or haven't been active recently
			if (connection.ws.readyState !== 1 || // Not WebSocket.OPEN
				(now - connection.lastActivity.getTime()) > staleTimeout) {
				console.log(`Cleaning up stale connection: ${connectionId}`);
				this.browserConnections.delete(connectionId);
				this.browserData.delete(connectionId);
				try {
					connection.ws.close();
				} catch (error) {
					// Ignore close errors for already closed connections
				}
			}
		}
	}

	// Direct message sending for health checks and notifications
	sendDirectMessageToBrowser(connectionId, message) {
		const connection = this.browserConnections.get(connectionId);
		if (!connection || connection.ws.readyState !== 1) { // WebSocket.OPEN
			console.error(`[HEALTH] Cannot send message to ${connectionId} - connection not available`);
			return false;
		}

		try {
			connection.ws.send(JSON.stringify(message));
			console.error(`[HEALTH] Sent direct message to ${connectionId}:`, message.type);
			return true;
		} catch (error) {
			console.error(`[HEALTH] Failed to send direct message to ${connectionId}:`, error);
			return false;
		}
	}

	// MCP Tool implementations
	async sendToBrowser(action, params = {}) {
		// Clean up stale connections first
		this.cleanupStaleConnections();
		
		if (this.browserConnections.size === 0) {
			throw new Error("No browser extensions connected");
		}

		// Find the most recent active connection
		const connections = Array.from(this.browserConnections.values());
		const connection = connections
			.filter(conn => conn.ws.readyState === 1) // WebSocket.OPEN
			.sort((a, b) => b.lastActivity - a.lastActivity)[0];
		
		if (!connection) {
			throw new Error("No healthy browser connections available");
		}

		return new Promise((resolve, reject) => {
			const requestId = uuidv4();
			let isResolved = false;
			
			// Configure timeout based on action complexity or custom timeout
			const getTimeoutForAction = (action, customTimeout) => {
				// Use custom timeout if provided and within limits
				if (customTimeout && customTimeout >= 5000 && customTimeout <= 120000) {
					return customTimeout;
				}
				
				switch (action) {
					case 'getAccessibilityTree':
						return 30000; // 30 seconds for accessibility analysis
					case 'getDOMSnapshot':
						return 20000; // 20 seconds for complex DOM structures
					default:
						return 10000; // 10 seconds for other actions
				}
			};
			
			const timeoutMs = getTimeoutForAction(action, params.timeout);
			
			const cleanup = () => {
				if (timeout) {
					clearTimeout(timeout);
				}
				connection.ws.off("message", responseHandler);
			};
			
			const timeout = setTimeout(() => {
				if (!isResolved) {
					isResolved = true;
					cleanup();
					console.error(`[DEBUG] Request ${requestId} for action ${action} timed out after ${timeoutMs/1000} seconds`);
					reject(new Error(`Browser request timeout for action: ${action} (${timeoutMs/1000}s)`));
				}
			}, timeoutMs);

			const responseHandler = (data) => {
				try {
					const message = JSON.parse(data.toString());
					if (message.type === "response" && message.requestId === requestId) {
						if (!isResolved) {
							isResolved = true;
							cleanup();
							resolve(message.data);
						}
					} else if (
						message.type === "error" &&
						message.requestId === requestId
					) {
						if (!isResolved) {
							isResolved = true;
							cleanup();
							reject(new Error(message.error));
						}
					}
				} catch (error) {
					// Ignore parsing errors for other messages
					console.error(`[DEBUG] Error parsing response for ${requestId}:`, error);
				}
			};

			// Ensure connection is still valid before sending
			if (connection.ws.readyState !== 1) { // WebSocket.OPEN
				isResolved = true;
				cleanup();
				reject(new Error("WebSocket connection not open"));
				return;
			}

			connection.ws.on("message", responseHandler);
			
			try {
				connection.ws.send(
					JSON.stringify({
						action,
						requestId,
						...params,
					}),
				);
				console.error(`[DEBUG] Sent request ${requestId} for action ${action}`);
			} catch (sendError) {
				if (!isResolved) {
					isResolved = true;
					cleanup();
					reject(new Error(`Failed to send request: ${sendError.message}`));
				}
			}
		});
	}

	async getPageContent(tabId, includeMetadata = true) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const pageContent = await this.sendToBrowser("getPageContent", params);

			if (!pageContent) {
				throw new Error("No page content available");
			}

			const result = {
				url: pageContent.url,
				title: pageContent.title,
				text: pageContent.text,
				html: includeMetadata ? pageContent.html : undefined,
				metadata: includeMetadata ? pageContent.metadata : undefined,
			};

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get page content: ${error.message}`);
		}
	}

	async getDOMSnapshot(tabId, maxDepth = 10, includeStyles = false) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const domSnapshot = await this.sendToBrowser("getDOMSnapshot", params);

			if (!domSnapshot) {
				throw new Error("No DOM snapshot available");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(domSnapshot, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get DOM snapshot: ${error.message}`);
		}
	}

	async executeJavaScript(tabId, code) {
		try {
			const params = { script: code };
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const result = await this.sendToBrowser("executeScript", params);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ result }, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to execute JavaScript: ${error.message}`);
		}
	}

	async getConsoleMessages(tabId, types, limit = 100) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const consoleLogs = await this.sendToBrowser("getConsoleMessages", params);

			if (!consoleLogs) {
				throw new Error("No console messages available");
			}

			let messages = consoleLogs;

			if (types && types.length > 0) {
				messages = messages.filter((msg) => types.includes(msg.type));
			}

			messages = messages.slice(-limit);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ messages, count: messages.length }, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get console messages: ${error.message}`);
		}
	}

	async getNetworkRequests(tabId, limit = 50) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const networkData = await this.sendToBrowser("getNetworkData", params);

			if (!networkData) {
				throw new Error("No network data available");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(networkData, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get network requests: ${error.message}`);
		}
	}

	async captureScreenshot(tabId, format = "png", quality = 90) {
		try {
			const params = { format, quality };
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const screenshot = await this.sendToBrowser("captureScreenshot", params);

			if (!screenshot) {
				throw new Error("No screenshot available");
			}

			return {
				content: [
					{
						type: "text",
						text: `Screenshot captured in ${format} format. Data URL: ${screenshot.substring(0, 100)}...`,
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to capture screenshot: ${error.message}`);
		}
	}

	async getPerformanceMetrics(tabId) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const performanceMetrics = await this.sendToBrowser("getPerformanceMetrics", params);

			if (!performanceMetrics) {
				throw new Error("No performance metrics available");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(performanceMetrics, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get performance metrics: ${error.message}`);
		}
	}

	async getAccessibilityTree(tabId, timeout) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			if (timeout !== undefined && timeout !== null) {
				params.timeout = timeout;
			}
			const accessibilityTree = await this.sendToBrowser("getAccessibilityTree", params);

			if (!accessibilityTree) {
				throw new Error("No accessibility tree available");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(accessibilityTree, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get accessibility tree: ${error.message}`);
		}
	}

	async getBrowserTabs() {
		try {
			const tabs = await this.sendToBrowser("getAllTabs");

			if (!tabs) {
				throw new Error("No tab information available");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(tabs, null, 2),
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to get browser tabs: ${error.message}`);
		}
	}

	async attachDebugger(tabId) {
		try {
			if (tabId === undefined || tabId === null) {
				throw new Error('tabId is required for debugger operations');
			}
			await this.sendToBrowser("attachDebugger", { tabId });

			return {
				content: [
					{
						type: "text",
						text: `Debugger attached to tab ${tabId}`,
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to attach debugger: ${error.message}`);
		}
	}

	async detachDebugger(tabId) {
		try {
			if (tabId === undefined || tabId === null) {
				throw new Error('tabId is required for debugger operations');
			}
			await this.sendToBrowser("detachDebugger", { tabId });

			return {
				content: [
					{
						type: "text",
						text: `Debugger detached from tab ${tabId}`,
					},
				],
			};
		} catch (error) {
			throw new Error(`Failed to detach debugger: ${error.message}`);
		}
	}

	async start() {
		await this.setupHttpServer();
		console.error("Browser MCP Bridge Server running on HTTP");
	}
}

// Start the HTTP server
const server = new BrowserMCPHttpServer();
server.start().catch(console.error);
