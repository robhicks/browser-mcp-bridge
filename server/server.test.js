import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for Browser MCP Server data optimization features
 * Tests the utility methods for truncation, filtering, and pagination
 */

// Test implementation class with only the utility methods we're testing
class BrowserMCPTestHelper {
	constructor() {
		this.paginationCursors = new Map();

		// Constants from server
		this.MAX_HTML_SIZE = 50000;
		this.MAX_TEXT_SIZE = 30000;
		this.MAX_DOM_NODES = 500;
		this.MAX_RESPONSE_SIZE = 100000;
		this.MAX_CONSOLE_MESSAGES = 50;
		this.MAX_NETWORK_REQUESTS = 50;
		this.MAX_REQUEST_BODY_SIZE = 10000;
		this.MAX_RESPONSE_BODY_SIZE = 10000;
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
		const cursorId = `cursor-${Date.now()}-${Math.random()}`;
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
}

// ==================== Test Suites ====================

describe('Truncation Utilities', () => {
	const helper = new BrowserMCPTestHelper();

	it('should truncate string when exceeds max length', () => {
		const longString = 'a'.repeat(1000);
		const truncated = helper.truncateString(longString, 100);

		assert.ok(truncated.length > 100, 'Truncated string should be longer than limit due to indicator');
		assert.ok(truncated.includes('[TRUNCATED'), 'Should include truncation indicator');
		assert.ok(truncated.includes('1000'), 'Should include original size');
	});

	it('should not truncate string under max length', () => {
		const shortString = 'short string';
		const result = helper.truncateString(shortString, 100);

		assert.strictEqual(result, shortString, 'Short strings should not be truncated');
	});

	it('should handle null or undefined strings', () => {
		assert.strictEqual(helper.truncateString(null, 100), null);
		assert.strictEqual(helper.truncateString(undefined, 100), undefined);
	});

	it('should truncate DOM tree to max nodes', () => {
		const domTree = {
			tag: 'div',
			attributes: { id: 'root' },
			children: Array(100).fill(null).map((_, i) => ({
				tag: 'span',
				attributes: { class: 'item' },
				text: `Item ${i}`
			}))
		};

		const nodeCount = { value: 0 };
		const truncated = helper.truncateDOMTree(domTree, 10, nodeCount);

		assert.ok(nodeCount.value <= 10, 'Should not exceed max nodes');
		assert.ok(truncated.children.length < domTree.children.length, 'Should have fewer children');
		assert.ok(truncated.children.some(child => child.truncated), 'Should mark truncation');
	});

	it('should preserve DOM structure when under max nodes', () => {
		const domTree = {
			tag: 'div',
			attributes: { id: 'root' },
			children: [
				{ tag: 'span', attributes: {}, text: 'Child 1' },
				{ tag: 'span', attributes: {}, text: 'Child 2' }
			]
		};

		const nodeCount = { value: 0 };
		const result = helper.truncateDOMTree(domTree, 100, nodeCount);

		assert.strictEqual(result.tag, 'div');
		assert.strictEqual(result.children.length, 2);
		assert.strictEqual(nodeCount.value, 3); // root + 2 children
	});
});

describe('Console Message Filtering', () => {
	const helper = new BrowserMCPTestHelper();
	const testMessages = [
		{ level: 'error', message: 'Authentication failed', timestamp: 1000 },
		{ level: 'warn', message: 'Deprecated API usage', timestamp: 2000 },
		{ level: 'info', message: 'User logged in', timestamp: 3000 },
		{ level: 'log', message: 'Debug information', timestamp: 4000 },
		{ level: 'error', message: 'Network timeout', timestamp: 5000 }
	];

	it('should filter by log levels', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {
			logLevels: ['error']
		});

		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every(msg => msg.level === 'error'));
	});

	it('should filter by multiple log levels', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {
			logLevels: ['error', 'warn']
		});

		assert.strictEqual(filtered.length, 3);
		assert.ok(filtered.every(msg => msg.level === 'error' || msg.level === 'warn'));
	});

	it('should filter by search term (case insensitive)', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {
			searchTerm: 'auth'
		});

		assert.strictEqual(filtered.length, 1);
		assert.ok(filtered[0].message.toLowerCase().includes('auth'));
	});

	it('should filter by timestamp', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {
			since: 3000
		});

		assert.strictEqual(filtered.length, 3);
		assert.ok(filtered.every(msg => msg.timestamp >= 3000));
	});

	it('should combine multiple filters', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {
			logLevels: ['error', 'warn'],
			since: 2000
		});

		// Should get: warn at 2000, error at 5000 (2 messages >= 2000 that are error or warn)
		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every(msg =>
			(msg.level === 'error' || msg.level === 'warn') && msg.timestamp >= 2000
		));
	});

	it('should return all messages when no filters', () => {
		const filtered = helper.filterConsoleMessages(testMessages, {});

		assert.strictEqual(filtered.length, testMessages.length);
	});
});

describe('Network Request Filtering', () => {
	const helper = new BrowserMCPTestHelper();
	const testRequests = [
		{ method: 'GET', status: 200, url: 'https://api.example.com/users', type: 'xhr' },
		{ method: 'POST', status: 201, url: 'https://api.example.com/users', type: 'xhr' },
		{ method: 'GET', status: 404, url: 'https://api.example.com/notfound', type: 'xhr' },
		{ method: 'GET', status: 500, url: 'https://api.example.com/error', type: 'xhr' },
		{ method: 'GET', status: 200, url: 'https://cdn.example.com/script.js', type: 'script' }
	];

	it('should filter by HTTP method', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			method: 'POST'
		});

		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].method, 'POST');
	});

	it('should filter by single status code', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			status: 404
		});

		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].status, 404);
	});

	it('should filter by multiple status codes', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			status: [404, 500]
		});

		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every(req => req.status === 404 || req.status === 500));
	});

	it('should filter by resource type', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			resourceType: 'script'
		});

		assert.strictEqual(filtered.length, 1);
		assert.strictEqual(filtered[0].type, 'script');
	});

	it('should filter by domain', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			domain: 'cdn.example.com'
		});

		assert.strictEqual(filtered.length, 1);
		assert.ok(filtered[0].url.includes('cdn.example.com'));
	});

	it('should filter failed requests only', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			failedOnly: true
		});

		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every(req => req.status >= 400));
	});

	it('should combine multiple filters', () => {
		const filtered = helper.filterNetworkRequests(testRequests, {
			method: 'GET',
			resourceType: 'xhr',
			failedOnly: true
		});

		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every(req =>
			req.method === 'GET' && req.type === 'xhr' && req.status >= 400
		));
	});
});

describe('DOM Filtering', () => {
	const helper = new BrowserMCPTestHelper();
	const testDOM = {
		tag: 'div',
		attributes: { id: 'app' },
		children: [
			{
				tag: 'header',
				attributes: { class: 'header' },
				children: [
					{ tag: 'h1', attributes: {}, text: 'Title' }
				]
			},
			{
				tag: 'main',
				attributes: { class: 'main-content' },
				children: [
					{ tag: 'p', attributes: {}, text: 'Content' }
				]
			},
			{
				tag: 'script',
				attributes: { src: 'app.js' },
				children: []
			},
			{
				tag: 'style',
				attributes: {},
				text: 'body { margin: 0; }'
			}
		]
	};

	it('should filter by ID selector', () => {
		const filtered = helper.filterDOMBySelector(testDOM, '#app');

		assert.ok(filtered);
		assert.strictEqual(filtered.attributes.id, 'app');
	});

	it('should filter by class selector', () => {
		const filtered = helper.filterDOMBySelector(testDOM, '.header');

		assert.ok(filtered);
		assert.strictEqual(filtered.tag, 'header');
	});

	it('should filter by tag selector', () => {
		const filtered = helper.filterDOMBySelector(testDOM, 'main');

		assert.ok(filtered);
		assert.strictEqual(filtered.tag, 'main');
	});

	it('should return null when selector not found', () => {
		const filtered = helper.filterDOMBySelector(testDOM, '#notfound');

		assert.strictEqual(filtered, null);
	});

	it('should exclude script tags', () => {
		const filtered = helper.filterDOMTree(testDOM, {
			excludeScripts: true,
			excludeStyles: false
		});

		assert.ok(filtered);
		assert.ok(!filtered.children.some(child => child?.tag === 'script'));
		assert.ok(filtered.children.some(child => child?.tag === 'style'));
	});

	it('should exclude style tags', () => {
		const filtered = helper.filterDOMTree(testDOM, {
			excludeScripts: false,
			excludeStyles: true
		});

		assert.ok(filtered);
		assert.ok(filtered.children.some(child => child?.tag === 'script'));
		assert.ok(!filtered.children.some(child => child?.tag === 'style'));
	});

	it('should exclude both scripts and styles', () => {
		const filtered = helper.filterDOMTree(testDOM, {
			excludeScripts: true,
			excludeStyles: true
		});

		assert.ok(filtered);
		assert.strictEqual(filtered.children.length, 2); // Only header and main
		assert.ok(!filtered.children.some(child => child?.tag === 'script'));
		assert.ok(!filtered.children.some(child => child?.tag === 'style'));
	});
});

describe('Pagination', () => {
	const helper = new BrowserMCPTestHelper();
	const testData = Array(100).fill(null).map((_, i) => ({ id: i, value: `item-${i}` }));

	it('should paginate data correctly', () => {
		const page1 = helper.paginateData(testData, null, 10);

		assert.strictEqual(page1.data.length, 10);
		assert.strictEqual(page1.data[0].id, 0);
		assert.strictEqual(page1.total, 100);
		assert.strictEqual(page1.hasMore, true);
		assert.ok(page1.nextCursor);
	});

	it('should get second page using cursor', () => {
		const page1 = helper.paginateData(testData, null, 10);
		const page2 = helper.paginateData(testData, page1.nextCursor, 10);

		assert.strictEqual(page2.data.length, 10);
		assert.strictEqual(page2.data[0].id, 10);
		assert.strictEqual(page2.offset, 10);
		assert.strictEqual(page2.hasMore, true);
	});

	it('should indicate no more pages on last page', () => {
		const lastPage = helper.paginateData(testData, null, 100);

		assert.strictEqual(lastPage.data.length, 100);
		assert.strictEqual(lastPage.hasMore, false);
		assert.strictEqual(lastPage.nextCursor, null);
	});

	it('should handle partial last page', () => {
		const page = helper.paginateData(testData, null, 95);
		assert.strictEqual(page.data.length, 95);
		assert.strictEqual(page.hasMore, true);

		const lastPage = helper.paginateData(testData, page.nextCursor, 95);
		assert.strictEqual(lastPage.data.length, 5);
		assert.strictEqual(lastPage.hasMore, false);
	});

	it('should handle empty data', () => {
		const page = helper.paginateData([], null, 10);

		assert.strictEqual(page.data.length, 0);
		assert.strictEqual(page.total, 0);
		assert.strictEqual(page.hasMore, false);
		assert.strictEqual(page.nextCursor, null);
	});

	it('should generate unique cursors', () => {
		const page1 = helper.paginateData(testData, null, 10);
		const page2 = helper.paginateData(testData, page1.nextCursor, 10);

		assert.notStrictEqual(page1.nextCursor, page2.nextCursor);
	});

	it('should clean up old cursors', () => {
		// Add an old cursor
		const oldCursorId = 'old-cursor';
		helper.paginationCursors.set(oldCursorId, {
			data: testData,
			offset: 0,
			timestamp: Date.now() - 6 * 60 * 1000 // 6 minutes ago
		});

		// Generate a new cursor (should trigger cleanup)
		helper.generateCursor(testData, 0, 10);

		// Old cursor should be deleted
		assert.strictEqual(helper.paginationCursors.has(oldCursorId), false);
	});
});

describe('Data Size Calculation', () => {
	const helper = new BrowserMCPTestHelper();

	it('should calculate size of simple objects', () => {
		const data = { name: 'test', value: 123 };
		const size = helper.getDataSize(data);

		assert.strictEqual(size, JSON.stringify(data).length);
	});

	it('should calculate size of nested objects', () => {
		const data = {
			user: {
				name: 'John',
				profile: {
					age: 30,
					interests: ['coding', 'music']
				}
			}
		};
		const size = helper.getDataSize(data);

		assert.strictEqual(size, JSON.stringify(data).length);
	});

	it('should calculate size of arrays', () => {
		const data = Array(100).fill({ id: 1, name: 'test' });
		const size = helper.getDataSize(data);

		assert.ok(size > 0);
		assert.strictEqual(size, JSON.stringify(data).length);
	});
});

describe('Integration Tests', () => {
	const helper = new BrowserMCPTestHelper();

	it('should filter and paginate console messages together', () => {
		const messages = Array(100).fill(null).map((_, i) => ({
			level: i % 2 === 0 ? 'error' : 'info',
			message: `Message ${i}`,
			timestamp: i * 1000
		}));

		// Filter to errors only
		const filtered = helper.filterConsoleMessages(messages, {
			logLevels: ['error']
		});

		assert.strictEqual(filtered.length, 50);

		// Paginate filtered results
		const page = helper.paginateData(filtered, null, 10);

		assert.strictEqual(page.data.length, 10);
		assert.strictEqual(page.total, 50);
		assert.ok(page.data.every(msg => msg.level === 'error'));
	});

	it('should filter and paginate network requests together', () => {
		const requests = Array(100).fill(null).map((_, i) => ({
			method: i % 2 === 0 ? 'GET' : 'POST',
			status: i % 3 === 0 ? 404 : 200,
			url: `https://api.example.com/endpoint${i}`,
			type: 'xhr'
		}));

		// Filter to failed requests only
		const filtered = helper.filterNetworkRequests(requests, {
			failedOnly: true
		});

		assert.ok(filtered.length > 0);
		assert.ok(filtered.every(req => req.status >= 400));

		// Paginate filtered results
		const page = helper.paginateData(filtered, null, 10);

		assert.strictEqual(page.data.length, 10);
		assert.ok(page.data.every(req => req.status >= 400));
	});

	it('should filter DOM and truncate together', () => {
		const largeDOM = {
			tag: 'div',
			attributes: { class: 'container' },
			children: Array(100).fill(null).map((_, i) => ({
				tag: i % 2 === 0 ? 'div' : 'script',
				attributes: {},
				text: `Content ${i}`
			}))
		};

		// Filter out scripts
		const filtered = helper.filterDOMTree(largeDOM, {
			excludeScripts: true
		});

		assert.ok(filtered.children.length < largeDOM.children.length);
		assert.ok(!filtered.children.some(child => child?.tag === 'script'));

		// Truncate to max nodes
		const nodeCount = { value: 0 };
		const truncated = helper.truncateDOMTree(filtered, 20, nodeCount);

		assert.ok(nodeCount.value <= 20);
	});
});
