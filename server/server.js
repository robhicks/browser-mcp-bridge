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

		// Data size limits (in characters)
		this.MAX_HTML_SIZE = 50000;  // 50KB of HTML
		this.MAX_TEXT_SIZE = 30000;  // 30KB of text
		this.MAX_DOM_NODES = 500;    // 500 DOM nodes
		this.MAX_RESPONSE_SIZE = 100000; // 100KB total response
		this.MAX_CONSOLE_MESSAGES = 50; // Default console message limit
		this.MAX_NETWORK_REQUESTS = 50; // Default network request limit
		this.MAX_REQUEST_BODY_SIZE = 10000; // 10KB max body size
		this.MAX_RESPONSE_BODY_SIZE = 10000; // 10KB max body size

		// Pagination cursors storage
		this.paginationCursors = new Map();

		this.setupMCPHandlers();
	}

	// Utility: Truncate string with indicator
	truncateString(str, maxLength, indicator = "\n... [TRUNCATED - original size: {{size}}]") {
		if (!str || str.length <= maxLength) return str;
		const truncated = str.substring(0, maxLength);
		return truncated + indicator.replace("{{size}}", str.length.toString());
	}

	// Utility: Calculate approximate size of JSON data
	getDataSize(data) {
		return JSON.stringify(data).length;
	}

	// Utility: Truncate DOM tree to max nodes
	truncateDOMTree(node, maxNodes, currentCount = { value: 0 }) {
		if (!node || currentCount.value >= maxNodes) {
			return { truncated: true, reason: "Max nodes reached" };
		}

		currentCount.value++;

		const result = {
			tag: node.tag,
			attributes: node.attributes,
			text: node.text ? this.truncateString(node.text, 500) : undefined
		};

		if (node.children && node.children.length > 0 && currentCount.value < maxNodes) {
			result.children = [];
			for (const child of node.children) {
				if (currentCount.value >= maxNodes) {
					result.children.push({
						truncated: true,
						remainingChildren: node.children.length - result.children.length
					});
					break;
				}
				result.children.push(this.truncateDOMTree(child, maxNodes, currentCount));
			}
		}

		return result;
	}

	// Utility: Filter console messages by type and search term
	filterConsoleMessages(messages, options = {}) {
		const { logLevels, searchTerm, since } = options;
		let filtered = messages;

		// Filter by log levels
		if (logLevels && logLevels.length > 0) {
			filtered = filtered.filter(msg => logLevels.includes(msg.level || msg.type));
		}

		// Filter by search term
		if (searchTerm) {
			const searchLower = searchTerm.toLowerCase();
			filtered = filtered.filter(msg => {
				const text = (msg.message || msg.text || '').toLowerCase();
				return text.includes(searchLower);
			});
		}

		// Filter by timestamp
		if (since) {
			filtered = filtered.filter(msg => {
				const msgTime = msg.timestamp || msg.time || 0;
				return msgTime >= since;
			});
		}

		return filtered;
	}

	// Utility: Filter network requests
	filterNetworkRequests(requests, options = {}) {
		const { method, status, resourceType, domain, failedOnly } = options;
		let filtered = requests;

		// Filter by HTTP method
		if (method) {
			filtered = filtered.filter(req =>
				(req.method || req.request?.method || '').toUpperCase() === method.toUpperCase()
			);
		}

		// Filter by status code
		if (status) {
			filtered = filtered.filter(req => {
				const reqStatus = req.status || req.response?.status;
				if (Array.isArray(status)) {
					return status.includes(reqStatus);
				}
				return reqStatus === status;
			});
		}

		// Filter by resource type
		if (resourceType) {
			const types = Array.isArray(resourceType) ? resourceType : [resourceType];
			filtered = filtered.filter(req =>
				types.includes(req.type || req.resourceType)
			);
		}

		// Filter by domain
		if (domain) {
			filtered = filtered.filter(req => {
				const url = req.url || req.request?.url || '';
				try {
					const reqDomain = new URL(url).hostname;
					return reqDomain.includes(domain);
				} catch (e) {
					return false;
				}
			});
		}

		// Filter failed requests only
		if (failedOnly) {
			filtered = filtered.filter(req => {
				const status = req.status || req.response?.status || 0;
				return status >= 400 || status === 0;
			});
		}

		return filtered;
	}

	// Utility: Filter DOM tree by selector
	filterDOMBySelector(node, selector) {
		if (!node || !selector) return node;

		// Simple implementation - in a real scenario, you'd want more sophisticated matching
		const matches = (node) => {
			if (!node.attributes) return false;

			// Check class selector
			if (selector.startsWith('.')) {
				const className = selector.substring(1);
				const nodeClasses = node.attributes.class || '';
				return nodeClasses.split(' ').includes(className);
			}

			// Check id selector
			if (selector.startsWith('#')) {
				const id = selector.substring(1);
				return node.attributes.id === id;
			}

			// Check tag selector
			return node.tag?.toLowerCase() === selector.toLowerCase();
		};

		if (matches(node)) {
			return node;
		}

		// Search children
		if (node.children) {
			for (const child of node.children) {
				const found = this.filterDOMBySelector(child, selector);
				if (found) return found;
			}
		}

		return null;
	}

	// Utility: Generate pagination cursor
	generateCursor(data, offset, limit) {
		const cursorId = uuidv4();
		this.paginationCursors.set(cursorId, {
			data,
			offset: offset + limit,
			timestamp: Date.now()
		});

		// Clean up old cursors (older than 5 minutes)
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		for (const [id, cursor] of this.paginationCursors.entries()) {
			if (cursor.timestamp < fiveMinutesAgo) {
				this.paginationCursors.delete(id);
			}
		}

		return cursorId;
	}

	// Utility: Paginate array data
	paginateData(data, cursor, pageSize) {
		let offset = 0;
		let dataSource = data;

		// If cursor exists, use stored pagination state
		if (cursor) {
			const paginationState = this.paginationCursors.get(cursor);
			if (paginationState) {
				offset = paginationState.offset;
				dataSource = paginationState.data;
			}
		}

		const paginatedData = dataSource.slice(offset, offset + pageSize);
		const hasMore = offset + pageSize < dataSource.length;
		const nextCursor = hasMore ? this.generateCursor(dataSource, offset, pageSize) : null;

		return {
			data: paginatedData,
			hasMore,
			nextCursor,
			total: dataSource.length,
			offset,
			pageSize
		};
	}

	setupMCPHandlers() {
		// List available tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => {
			return {
				tools: [
					{
						name: "get_page_content",
						description: "Get the full content and metadata of a web page. Returns text content by default for optimal performance.",
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
								includeHtml: {
									type: "boolean",
									description:
										"Include full HTML (may be large, truncated at 50KB). Default: false",
									default: false,
								},
								maxTextLength: {
									type: "number",
									description:
										"Maximum length of text content (default: 30000 chars)",
									default: 30000,
								},
							},
						},
					},
					{
						name: "get_dom_snapshot",
						description: "Get a structured snapshot of the DOM tree. Automatically limits to 500 nodes for optimal performance.",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								maxDepth: {
									type: "number",
									description: "Maximum DOM tree depth (default: 5 for performance)",
									default: 5,
								},
								maxNodes: {
									type: "number",
									description: "Maximum number of DOM nodes to return (default: 500)",
									default: 500,
								},
								includeStyles: {
									type: "boolean",
									description: "Include computed styles (increases size significantly)",
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
						description: "Get network requests and responses from the browser. Response bodies excluded by default for performance.",
						inputSchema: {
							type: "object",
							properties: {
								tabId: { type: "number", description: "Browser tab ID" },
								limit: {
									type: "number",
									description: "Maximum number of requests (default: 50)",
									default: 50,
								},
								includeResponseBodies: {
									type: "boolean",
									description: "Include response bodies (may be very large). Default: false",
									default: false,
								},
								includeRequestBodies: {
									type: "boolean",
									description: "Include request bodies (may be large). Default: false",
									default: false,
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
						let html = data.pageContent?.html || "";
						const originalHtmlSize = html.length;
						if (html.length > this.MAX_HTML_SIZE) {
							html = this.truncateString(html, this.MAX_HTML_SIZE);
						}
						return {
							contents: [
								{
									uri,
									mimeType: "text/html",
									text: html,
								},
							],
						};

					case "dom":
						let domData = data.domSnapshot;
						if (domData && domData.root) {
							const nodeCounter = { value: 0 };
							domData = {
								...domData,
								root: this.truncateDOMTree(domData.root, this.MAX_DOM_NODES, nodeCounter),
								truncated: nodeCounter.value >= this.MAX_DOM_NODES,
								returnedNodeCount: nodeCounter.value,
							};
						}
						return {
							contents: [
								{
									uri,
									mimeType: "application/json",
									text: JSON.stringify(domData, null, 2),
								},
							],
						};

					case "console":
						let consoleLogs = data.consoleLogs || [];
						// Limit to last 100 messages
						if (consoleLogs.length > 100) {
							consoleLogs = consoleLogs.slice(-100);
						}
						return {
							contents: [
								{
									uri,
									mimeType: "application/json",
									text: JSON.stringify({
										messages: consoleLogs,
										count: consoleLogs.length,
										limited: (data.consoleLogs || []).length > 100,
									}, null, 2),
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
					return await this.getPageContent(
						args?.tabId,
						args?.includeMetadata,
						args?.includeHtml,
						args?.maxTextLength
					);

				case "get_dom_snapshot":
					return await this.getDOMSnapshot(
						args?.tabId,
						args?.maxDepth,
						args?.includeStyles,
						args?.maxNodes,
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
					return await this.getNetworkRequests(
						args?.tabId,
						args?.limit,
						args?.includeResponseBodies,
						args?.includeRequestBodies
					);

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
					description: "Get the full content and metadata of a web page. Returns text content by default for optimal performance.",
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
							includeHtml: {
								type: "boolean",
								description:
									"Include full HTML (may be large, truncated at 50KB). Default: false",
								default: false,
							},
							maxTextLength: {
								type: "number",
								description:
									"Maximum length of text content (default: 30000 chars)",
								default: 30000,
							},
						},
					},
				},
				{
					name: "get_dom_snapshot",
					description: "Get a structured DOM snapshot with filtering. Limits to 500 nodes by default. Use selector to target specific elements for detailed inspection.",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							selector: {
								type: "string",
								description: "CSS selector to target specific elements (e.g., '.main-content', '#app', 'article'). Returns subtree starting from first match."
							},
							maxDepth: {
								type: "number",
								description: "Maximum DOM tree depth (default: 5 for performance, max: 15)",
								default: 5,
								minimum: 1,
								maximum: 15
							},
							maxNodes: {
								type: "number",
								description: "Maximum number of DOM nodes to return (default: 500, max: 2000)",
								default: 500,
								minimum: 10,
								maximum: 2000
							},
							includeStyles: {
								type: "boolean",
								description: "Include computed styles (increases size significantly). Default: false",
								default: false,
							},
							excludeScripts: {
								type: "boolean",
								description: "Exclude <script> tags from snapshot. Default: true",
								default: true
							},
							excludeStyles: {
								type: "boolean",
								description: "Exclude <style> tags from snapshot. Default: true",
								default: true
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
					description: "Get console messages from the browser with filtering and pagination. Returns errors/warnings by default for optimal relevance.",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							logLevels: {
								type: "array",
								items: { type: "string", enum: ["error", "warn", "info", "log", "debug"] },
								description: "Filter by log levels (default: ['error', 'warn'] for most relevant messages)",
								default: ["error", "warn"],
							},
							searchTerm: {
								type: "string",
								description: "Filter messages containing this search term (case-insensitive)"
							},
							since: {
								type: "number",
								description: "Only return messages after this timestamp (milliseconds)"
							},
							pageSize: {
								type: "number",
								description: "Number of messages per page (default: 50, max: 200)",
								default: 50,
								minimum: 1,
								maximum: 200
							},
							cursor: {
								type: "string",
								description: "Pagination cursor from previous response (for getting next page)"
							},
						},
					},
				},
				{
					name: "get_network_requests",
					description: "Get network requests with filtering and pagination. Response/request bodies excluded by default. Returns failed requests first for relevance.",
					inputSchema: {
						type: "object",
						properties: {
							tabId: { type: "number", description: "Browser tab ID" },
							method: {
								type: "string",
								description: "Filter by HTTP method (GET, POST, PUT, DELETE, etc.)",
								enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
							},
							status: {
								oneOf: [
									{ type: "number", description: "Filter by specific status code" },
									{ type: "array", items: { type: "number" }, description: "Filter by multiple status codes" }
								],
								description: "Filter by HTTP status code(s)"
							},
							resourceType: {
								oneOf: [
									{ type: "string" },
									{ type: "array", items: { type: "string" } }
								],
								description: "Filter by resource type (script, stylesheet, image, xhr, fetch, etc.)"
							},
							domain: {
								type: "string",
								description: "Filter by domain (matches if request URL contains this string)"
							},
							failedOnly: {
								type: "boolean",
								description: "Only return failed requests (4xx, 5xx status codes). Default: false",
								default: false
							},
							pageSize: {
								type: "number",
								description: "Number of requests per page (default: 50, max: 200)",
								default: 50,
								minimum: 1,
								maximum: 200
							},
							cursor: {
								type: "string",
								description: "Pagination cursor from previous response"
							},
							includeResponseBodies: {
								type: "boolean",
								description: "Include response bodies (truncated at 10KB). Default: false",
								default: false,
							},
							includeRequestBodies: {
								type: "boolean",
								description: "Include request bodies (truncated at 10KB). Default: false",
								default: false,
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
				let html = data.pageContent?.html || "";
				const originalHtmlSize = html.length;
				if (html.length > this.MAX_HTML_SIZE) {
					html = this.truncateString(html, this.MAX_HTML_SIZE);
				}
				return {
					contents: [
						{
							uri,
							mimeType: "text/html",
							text: html,
						},
					],
				};

			case "dom":
				let domData = data.domSnapshot;
				if (domData && domData.root) {
					const nodeCounter = { value: 0 };
					domData = {
						...domData,
						root: this.truncateDOMTree(domData.root, this.MAX_DOM_NODES, nodeCounter),
						truncated: nodeCounter.value >= this.MAX_DOM_NODES,
						returnedNodeCount: nodeCounter.value,
					};
				}
				return {
					contents: [
						{
							uri,
							mimeType: "application/json",
							text: JSON.stringify(domData, null, 2),
						},
					],
				};

			case "console":
				let consoleLogs = data.consoleLogs || [];
				// Limit to last 100 messages
				if (consoleLogs.length > 100) {
					consoleLogs = consoleLogs.slice(-100);
				}
				return {
					contents: [
						{
							uri,
							mimeType: "application/json",
							text: JSON.stringify({
								messages: consoleLogs,
								count: consoleLogs.length,
								limited: (data.consoleLogs || []).length > 100,
							}, null, 2),
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
				return await this.getPageContent(
					args?.tabId,
					args?.includeMetadata,
					args?.includeHtml,
					args?.maxTextLength
				);

			case "get_dom_snapshot":
				return await this.getDOMSnapshot(args?.tabId, {
					selector: args?.selector,
					maxDepth: args?.maxDepth,
					maxNodes: args?.maxNodes,
					includeStyles: args?.includeStyles,
					excludeScripts: args?.excludeScripts,
					excludeStyles: args?.excludeStyles
				});

			case "execute_javascript":
				return await this.executeJavaScript(args?.tabId, args.code);

			case "get_console_messages":
				return await this.getConsoleMessages(args?.tabId, {
					logLevels: args?.logLevels,
					searchTerm: args?.searchTerm,
					since: args?.since,
					pageSize: args?.pageSize,
					cursor: args?.cursor
				});

			case "get_network_requests":
				return await this.getNetworkRequests(args?.tabId, {
					method: args?.method,
					status: args?.status,
					resourceType: args?.resourceType,
					domain: args?.domain,
					failedOnly: args?.failedOnly,
					pageSize: args?.pageSize,
					cursor: args?.cursor,
					includeResponseBodies: args?.includeResponseBodies,
					includeRequestBodies: args?.includeRequestBodies
				});

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

	async getPageContent(tabId, includeMetadata = true, includeHtml = false, maxTextLength = 30000) {
		try {
			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const pageContent = await this.sendToBrowser("getPageContent", params);

			if (!pageContent) {
				throw new Error("No page content available");
			}

			// Truncate text content
			let text = pageContent.text || "";
			const originalTextSize = text.length;
			if (text.length > maxTextLength) {
				text = this.truncateString(text, maxTextLength);
			}

			// Truncate HTML if included
			let html = undefined;
			let htmlTruncated = false;
			if (includeHtml && pageContent.html) {
				const originalHtmlSize = pageContent.html.length;
				if (originalHtmlSize > this.MAX_HTML_SIZE) {
					html = this.truncateString(pageContent.html, this.MAX_HTML_SIZE);
					htmlTruncated = true;
				} else {
					html = pageContent.html;
				}
			}

			const result = {
				url: pageContent.url,
				title: pageContent.title,
				text: text,
				textTruncated: originalTextSize > maxTextLength,
				originalTextSize: originalTextSize,
				html: html,
				htmlTruncated: htmlTruncated,
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

	async getDOMSnapshot(tabId, options = {}) {
		try {
			const {
				selector,
				maxDepth = 5,
				maxNodes = 500,
				includeStyles = false,
				excludeScripts = true,
				excludeStyles = true
			} = options;

			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const domSnapshot = await this.sendToBrowser("getDOMSnapshot", params);

			if (!domSnapshot) {
				throw new Error("No DOM snapshot available");
			}

			let processedRoot = domSnapshot.root;

			// Apply selector filter if specified
			if (selector && processedRoot) {
				processedRoot = this.filterDOMBySelector(processedRoot, selector);
				if (!processedRoot) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								error: `No element found matching selector: ${selector}`,
								selector,
								message: "Try a different selector or omit to get full DOM"
							}, null, 2)
						}]
					};
				}
			}

			// Filter out scripts and styles if requested
			if (excludeScripts || excludeStyles) {
				processedRoot = this.filterDOMTree(processedRoot, {
					excludeScripts,
					excludeStyles
				});
			}

			// Truncate DOM tree to maxNodes
			const originalNodeCount = domSnapshot.nodeCount || 0;
			let wasTruncated = false;
			let returnedNodeCount = 0;

			if (processedRoot) {
				const nodeCounter = { value: 0 };
				processedRoot = this.truncateDOMTree(processedRoot, Math.min(maxNodes, 2000), nodeCounter);
				returnedNodeCount = nodeCounter.value;
				wasTruncated = returnedNodeCount >= maxNodes;
			}

			// Remove styles if not requested
			if (!includeStyles && processedRoot) {
				this.removeStylesFromDOMTree(processedRoot);
			}

			const result = {
				root: processedRoot,
				nodeCount: returnedNodeCount,
				originalNodeCount: originalNodeCount,
				truncated: wasTruncated,
				filters: {
					selector: selector || null,
					maxDepth,
					maxNodes,
					excludeScripts,
					excludeStyles
				},
				message: wasTruncated
					? `DOM tree truncated to ${maxNodes} nodes (original: ${originalNodeCount} nodes). Use selector to target specific elements or increase maxNodes.`
					: selector
						? `Showing subtree for selector '${selector}' (${returnedNodeCount} nodes)`
						: `Showing complete DOM tree (${returnedNodeCount} nodes)`
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
			throw new Error(`Failed to get DOM snapshot: ${error.message}`);
		}
	}

	// Helper to filter DOM tree (exclude scripts/styles)
	filterDOMTree(node, options = {}) {
		if (!node) return null;

		const { excludeScripts, excludeStyles } = options;
		const tagLower = (node.tag || node.tagName || '').toLowerCase();

		// Exclude script tags
		if (excludeScripts && tagLower === 'script') {
			return null;
		}

		// Exclude style tags
		if (excludeStyles && tagLower === 'style') {
			return null;
		}

		const filtered = { ...node };

		if (node.children && node.children.length > 0) {
			filtered.children = node.children
				.map(child => this.filterDOMTree(child, options))
				.filter(child => child !== null);
		}

		return filtered;
	}

	// Helper to remove styles from DOM tree
	removeStylesFromDOMTree(node) {
		if (!node) return;
		delete node.styles;
		delete node.computedStyles;
		if (node.children) {
			node.children.forEach(child => this.removeStylesFromDOMTree(child));
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

	async getConsoleMessages(tabId, options = {}) {
		try {
			const {
				logLevels = ['error', 'warn'], // Default to errors and warnings for relevance
				searchTerm,
				since,
				pageSize = 50,
				cursor
			} = options;

			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const consoleLogs = await this.sendToBrowser("getConsoleMessages", params);

			if (!consoleLogs) {
				throw new Error("No console messages available");
			}

			// Apply filters
			let filtered = this.filterConsoleMessages(consoleLogs, {
				logLevels,
				searchTerm,
				since
			});

			// Apply pagination
			const paginated = this.paginateData(filtered, cursor, Math.min(pageSize, 200));

			const result = {
				messages: paginated.data,
				count: paginated.data.length,
				total: paginated.total,
				hasMore: paginated.hasMore,
				nextCursor: paginated.nextCursor,
				filters: {
					logLevels,
					searchTerm: searchTerm || null,
					since: since || null
				},
				message: paginated.total === 0
					? "No messages match the specified filters"
					: paginated.hasMore
						? `Showing ${paginated.data.length} of ${paginated.total} messages. Use nextCursor to get more.`
						: `Showing all ${paginated.total} matching messages`
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
			throw new Error(`Failed to get console messages: ${error.message}`);
		}
	}

	async getNetworkRequests(tabId, options = {}) {
		try {
			const {
				method,
				status,
				resourceType,
				domain,
				failedOnly = false,
				pageSize = 50,
				cursor,
				includeResponseBodies = false,
				includeRequestBodies = false
			} = options;

			const params = {};
			if (tabId !== undefined && tabId !== null) {
				params.tabId = tabId;
			}
			const networkData = await this.sendToBrowser("getNetworkData", params);

			if (!networkData) {
				throw new Error("No network data available");
			}

			let requests = networkData.requests || networkData || [];

			// Apply filters
			requests = this.filterNetworkRequests(requests, {
				method,
				status,
				resourceType,
				domain,
				failedOnly
			});

			// Sort: failed requests first for relevance
			if (failedOnly || !method && !status && !resourceType && !domain) {
				requests.sort((a, b) => {
					const statusA = a.status || a.response?.status || 0;
					const statusB = b.status || b.response?.status || 0;
					const failedA = statusA >= 400 || statusA === 0;
					const failedB = statusB >= 400 || statusB === 0;
					if (failedA && !failedB) return -1;
					if (!failedA && failedB) return 1;
					return 0;
				});
			}

			// Apply pagination
			const paginated = this.paginateData(requests, cursor, Math.min(pageSize, 200));

			// Process bodies
			const processedRequests = paginated.data.map(request => {
				const processed = { ...request };

				if (!includeResponseBodies && processed.response) {
					const originalSize = processed.response.body?.length || 0;
					if (originalSize > 0) {
						processed.response = {
							...processed.response,
							body: `[Response body excluded - ${originalSize} chars. Set includeResponseBodies:true to include]`,
							bodySize: originalSize
						};
					}
				} else if (includeResponseBodies && processed.response?.body) {
					const maxBodySize = this.MAX_RESPONSE_BODY_SIZE;
					if (processed.response.body.length > maxBodySize) {
						processed.response.body = this.truncateString(
							processed.response.body,
							maxBodySize,
							`\n... [Response body truncated from ${processed.response.body.length} chars]`
						);
					}
				}

				if (!includeRequestBodies && processed.request?.body) {
					const originalSize = processed.request.body.length;
					processed.request = {
						...processed.request,
						body: `[Request body excluded - ${originalSize} chars. Set includeRequestBodies:true to include]`,
						bodySize: originalSize
					};
				} else if (includeRequestBodies && processed.request?.body) {
					const maxBodySize = this.MAX_REQUEST_BODY_SIZE;
					if (processed.request.body.length > maxBodySize) {
						processed.request.body = this.truncateString(
							processed.request.body,
							maxBodySize,
							`\n... [Request body truncated from ${processed.request.body.length} chars]`
						);
					}
				}

				return processed;
			});

			const result = {
				requests: processedRequests,
				count: processedRequests.length,
				total: paginated.total,
				hasMore: paginated.hasMore,
				nextCursor: paginated.nextCursor,
				filters: {
					method: method || null,
					status: status || null,
					resourceType: resourceType || null,
					domain: domain || null,
					failedOnly
				},
				message: paginated.total === 0
					? "No requests match the specified filters"
					: paginated.hasMore
						? `Showing ${processedRequests.length} of ${paginated.total} requests. Use nextCursor to get more.`
						: `Showing all ${paginated.total} matching requests`
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
