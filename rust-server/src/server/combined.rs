use crate::server::SimpleBrowserMcpServer;
use crate::utils::truncation;
use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        ConnectInfo, State, Json,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use serde_json::Value;

/// Combined HTTP server that handles both MCP JSON-RPC and WebSocket upgrades on the same port
pub async fn start_combined_server(
    mcp_handler: Arc<SimpleBrowserMcpServer>,
    host: &str,
    port: u16,
) -> anyhow::Result<()> {
    let app = Router::new()
        // MCP JSON-RPC endpoint (POST)
        .route("/mcp", post(handle_mcp_request))
        // WebSocket upgrade endpoint (GET)
        .route("/ws", get(handle_websocket_upgrade))
        // Health check endpoint
        .route("/health", get(handle_health_check))
        // Connection cleanup endpoint
        .route("/cleanup-connections", post(handle_cleanup_connections))
        .layer(CorsLayer::permissive())
        .with_state(mcp_handler);

    let addr = format!("{}:{}", host, port);
    let listener = TcpListener::bind(&addr).await?;

    tracing::info!("Combined HTTP/WebSocket server listening on {}", addr);
    tracing::info!("  MCP endpoint: POST http://{}/mcp", addr);
    tracing::info!("  WebSocket endpoint: GET ws://{}/ws", addr);
    tracing::info!("  Health check: GET http://{}/health", addr);
    tracing::info!("  Cleanup: POST http://{}/cleanup-connections", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

/// Handle MCP JSON-RPC requests over HTTP
async fn handle_mcp_request(
    State(server): State<Arc<SimpleBrowserMcpServer>>,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    tracing::debug!("Received MCP request: {}", serde_json::to_string(&request).unwrap_or_default());

    // Validate JSON-RPC format
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(|v| v.as_str()) {
        Some(method) => method,
        None => {
            let error_response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32600,
                    "message": "Invalid Request",
                    "data": "Missing 'method' field"
                }
            });
            return (StatusCode::BAD_REQUEST, Json(error_response));
        }
    };

    // Handle JSON-RPC methods
    let result = match method {
        "initialize" => handle_initialize(request.get("params")),
        "notifications/initialized" => {
            tracing::info!("Client initialized successfully");
            return (StatusCode::OK, Json(serde_json::json!({})));
        }
        "tools/list" => handle_tools_list().await,
        "resources/list" => handle_resources_list(server.clone()).await,
        "resources/read" => {
            match request.get("params") {
                Some(params) => handle_resource_read(server.clone(), params).await,
                None => Err("Missing params for resources/read".to_string()),
            }
        }
        "tools/call" => {
            match request.get("params") {
                Some(params) => handle_tool_call(server.clone(), params).await,
                None => Err("Missing params for tools/call".to_string()),
            }
        }
        _ => Err(format!("Unknown method: {}", method)),
    };

    // Format JSON-RPC response
    let response = match result {
        Ok(data) => serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": data
        }),
        Err(error_msg) => serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32603,
                "message": "Internal error",
                "data": error_msg
            }
        }),
    };

    tracing::debug!("Sending MCP response: {}", serde_json::to_string(&response).unwrap_or_default());
    (StatusCode::OK, Json(response))
}

/// Handle WebSocket upgrade requests
async fn handle_websocket_upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(server): State<Arc<SimpleBrowserMcpServer>>,
) -> impl IntoResponse {
    tracing::info!("WebSocket upgrade request from {}", addr);
    ws.on_upgrade(move |socket| handle_websocket_connection(socket, addr, server))
}

/// Handle individual WebSocket connections
async fn handle_websocket_connection(
    socket: WebSocket,
    addr: SocketAddr,
    server: Arc<SimpleBrowserMcpServer>,
) {
    tracing::info!("New WebSocket connection from {}", addr);
    server
        .connection_pool
        .handle_connection(socket, Some(addr))
        .await;
}

/// Handle health check requests
async fn handle_health_check(
    State(server): State<Arc<SimpleBrowserMcpServer>>,
) -> impl IntoResponse {
    let health_status = server.get_health_status().await;
    (StatusCode::OK, Json(health_status))
}

/// Handle connection cleanup requests
async fn handle_cleanup_connections(
    State(server): State<Arc<SimpleBrowserMcpServer>>,
) -> impl IntoResponse {
    tracing::info!("Manual connection cleanup requested");
    server.connection_pool.cleanup_stale_connections().await;
    let active = server.connection_pool.get_active_connections().await.len();
    (StatusCode::OK, Json(serde_json::json!({
        "message": "Connection cleanup completed",
        "activeConnections": active
    })))
}

// ─── MCP JSON-RPC handlers ───────────────────────────────────────────────────

fn handle_initialize(_params: Option<&Value>) -> Result<Value, String> {
    Ok(serde_json::json!({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "browser-mcp-rust-server",
            "version": "1.0.0"
        },
        "capabilities": {
            "tools": {},
            "resources": {}
        }
    }))
}

async fn handle_tools_list() -> Result<Value, String> {
    Ok(serde_json::json!({
        "tools": [
            {
                "name": "get_page_content",
                "description": "Get the full content and metadata of a web page. Returns text content by default for optimal performance.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID (optional, uses active tab if not specified)"
                        },
                        "includeMetadata": {
                            "type": "boolean",
                            "description": "Include page metadata like title, meta tags, etc.",
                            "default": true
                        },
                        "includeHtml": {
                            "type": "boolean",
                            "description": "Include full HTML (may be large, truncated at 50KB). Default: false",
                            "default": false
                        },
                        "maxTextLength": {
                            "type": "number",
                            "description": "Maximum length of text content (default: 30000 chars)",
                            "default": 30000
                        }
                    }
                }
            },
            {
                "name": "get_dom_snapshot",
                "description": "Get a structured DOM snapshot with filtering. Limits to 500 nodes by default. Use selector to target specific elements for detailed inspection.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector to target specific elements (e.g., '.main-content', '#app', 'article'). Returns subtree starting from first match."
                        },
                        "maxDepth": {
                            "type": "number",
                            "description": "Maximum DOM tree depth (default: 5 for performance, max: 15)",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 15
                        },
                        "maxNodes": {
                            "type": "number",
                            "description": "Maximum number of DOM nodes to return (default: 500, max: 2000)",
                            "default": 500,
                            "minimum": 10,
                            "maximum": 2000
                        },
                        "includeStyles": {
                            "type": "boolean",
                            "description": "Include computed styles (increases size significantly). Default: false",
                            "default": false
                        },
                        "excludeScripts": {
                            "type": "boolean",
                            "description": "Exclude <script> tags from snapshot. Default: true",
                            "default": true
                        },
                        "excludeStyles": {
                            "type": "boolean",
                            "description": "Exclude <style> tags from snapshot. Default: true",
                            "default": true
                        }
                    }
                }
            },
            {
                "name": "execute_javascript",
                "description": "Execute JavaScript code in the browser page context",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "code": {
                            "type": "string",
                            "description": "JavaScript code to execute"
                        }
                    },
                    "required": ["code"]
                }
            },
            {
                "name": "get_console_messages",
                "description": "Get console messages from the browser with filtering and pagination. Returns errors/warnings by default for optimal relevance.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "logLevels": {
                            "type": "array",
                            "items": { "type": "string", "enum": ["error", "warn", "info", "log", "debug"] },
                            "description": "Filter by log levels (default: ['error', 'warn'] for most relevant messages)",
                            "default": ["error", "warn"]
                        },
                        "searchTerm": {
                            "type": "string",
                            "description": "Filter messages containing this search term (case-insensitive)"
                        },
                        "since": {
                            "type": "number",
                            "description": "Only return messages after this timestamp (milliseconds)"
                        },
                        "pageSize": {
                            "type": "number",
                            "description": "Number of messages per page (default: 50, max: 200)",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "cursor": {
                            "type": "string",
                            "description": "Pagination cursor from previous response (for getting next page)"
                        }
                    }
                }
            },
            {
                "name": "get_network_requests",
                "description": "Get network requests with filtering and pagination. Response/request bodies excluded by default. Returns failed requests first for relevance.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "method": {
                            "type": "string",
                            "description": "Filter by HTTP method (GET, POST, PUT, DELETE, etc.)",
                            "enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
                        },
                        "status": {
                            "description": "Filter by HTTP status code(s)",
                            "oneOf": [
                                { "type": "number", "description": "Filter by specific status code" },
                                { "type": "array", "items": { "type": "number" }, "description": "Filter by multiple status codes" }
                            ]
                        },
                        "resourceType": {
                            "description": "Filter by resource type (script, stylesheet, image, xhr, fetch, etc.)",
                            "oneOf": [
                                { "type": "string" },
                                { "type": "array", "items": { "type": "string" } }
                            ]
                        },
                        "domain": {
                            "type": "string",
                            "description": "Filter by domain (matches if request URL contains this string)"
                        },
                        "failedOnly": {
                            "type": "boolean",
                            "description": "Only return failed requests (4xx, 5xx status codes). Default: false",
                            "default": false
                        },
                        "pageSize": {
                            "type": "number",
                            "description": "Number of requests per page (default: 50, max: 200)",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "cursor": {
                            "type": "string",
                            "description": "Pagination cursor from previous response"
                        },
                        "includeResponseBodies": {
                            "type": "boolean",
                            "description": "Include response bodies (truncated at 10KB). Default: false",
                            "default": false
                        },
                        "includeRequestBodies": {
                            "type": "boolean",
                            "description": "Include request bodies (truncated at 10KB). Default: false",
                            "default": false
                        }
                    }
                }
            },
            {
                "name": "capture_screenshot",
                "description": "Capture a screenshot of the current browser tab",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "format": {
                            "type": "string",
                            "enum": ["png", "jpeg"],
                            "default": "png"
                        },
                        "quality": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 100,
                            "default": 90
                        }
                    }
                }
            },
            {
                "name": "get_performance_metrics",
                "description": "Get performance metrics from the browser",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" }
                    }
                }
            },
            {
                "name": "get_accessibility_tree",
                "description": "Get the accessibility tree of the page",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "timeout": {
                            "type": "number",
                            "description": "Timeout in milliseconds (default: 30000, max: 120000)",
                            "default": 30000,
                            "minimum": 5000,
                            "maximum": 120000
                        }
                    }
                }
            },
            {
                "name": "get_browser_tabs",
                "description": "Get information about all open browser tabs",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            },
            {
                "name": "attach_debugger",
                "description": "Attach Chrome debugger to a tab for advanced inspection",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" }
                    },
                    "required": ["tabId"]
                }
            },
            {
                "name": "detach_debugger",
                "description": "Detach Chrome debugger from a tab",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" }
                    },
                    "required": ["tabId"]
                }
            }
        ]
    }))
}

async fn handle_resources_list(server: Arc<SimpleBrowserMcpServer>) -> Result<Value, String> {
    let mut resources = Vec::new();

    let all_tabs = server.data_cache.get_all_tabs().await;
    for tab_data in &all_tabs {
        let tab_id = tab_data.tab_id;

        if let Some(pc) = &tab_data.page_content {
            resources.push(serde_json::json!({
                "uri": format!("browser://tab/{}/content", tab_id),
                "name": format!("Page Content - {}", if pc.title.is_empty() { &pc.url } else { &pc.title }),
                "description": format!("Full page content from {}", pc.url),
                "mimeType": "text/html"
            }));
        }

        if tab_data.dom_snapshot.is_some() {
            resources.push(serde_json::json!({
                "uri": format!("browser://tab/{}/dom", tab_id),
                "name": format!("DOM Snapshot - tab {}", tab_id),
                "description": "Structured DOM tree",
                "mimeType": "application/json"
            }));
        }

        if let Some(console_logs) = &tab_data.console_logs {
            let count = console_logs.read().len();
            if count > 0 {
                resources.push(serde_json::json!({
                    "uri": format!("browser://tab/{}/console", tab_id),
                    "name": format!("Console Messages - {} messages", count),
                    "description": "Console logs, errors, and warnings",
                    "mimeType": "application/json"
                }));
            }
        }
    }

    Ok(serde_json::json!({ "resources": resources }))
}

async fn handle_resource_read(server: Arc<SimpleBrowserMcpServer>, params: &Value) -> Result<Value, String> {
    let uri = params.get("uri")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'uri' parameter")?;

    // Parse URI: browser://tab/{id}/{type}
    let re = regex::Regex::new(r"^browser://tab/(\d+)/(content|dom|console)$")
        .map_err(|e| e.to_string())?;

    let caps = re.captures(uri)
        .ok_or_else(|| format!("Invalid resource URI: {}", uri))?;

    let tab_id: u32 = caps.get(1).unwrap().as_str().parse()
        .map_err(|_| "Invalid tab ID".to_string())?;
    let resource_type = caps.get(2).unwrap().as_str();

    let tab_data = server.data_cache.get_tab_data(tab_id).await
        .ok_or_else(|| format!("No data available for tab {}", tab_id))?;

    match resource_type {
        "content" => {
            let html = tab_data.page_content.as_ref()
                .map(|pc| pc.html.as_str())
                .unwrap_or("");
            let (truncated_html, _) = truncation::truncate_string(html, truncation::MAX_HTML_SIZE);

            Ok(serde_json::json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "text/html",
                    "text": truncated_html
                }]
            }))
        }
        "dom" => {
            let dom_text = if let Some(dom) = &tab_data.dom_snapshot {
                let dom_value = serde_json::to_value(dom.as_ref())
                    .unwrap_or(Value::Null);

                // Truncate DOM tree
                if let Some(root) = dom_value.get("root") {
                    let mut count = 0;
                    let truncated_root = crate::utils::dom::truncate_dom_tree(
                        root, truncation::MAX_DOM_NODES, &mut count
                    );
                    let mut result = dom_value.clone();
                    result["root"] = truncated_root;
                    result["truncated"] = Value::Bool(count >= truncation::MAX_DOM_NODES);
                    result["returnedNodeCount"] = Value::Number(count.into());
                    serde_json::to_string_pretty(&result).unwrap_or_default()
                } else {
                    serde_json::to_string_pretty(&dom_value).unwrap_or_default()
                }
            } else {
                "null".to_string()
            };

            Ok(serde_json::json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": dom_text
                }]
            }))
        }
        "console" => {
            let console_data = if let Some(console_logs) = &tab_data.console_logs {
                let logs = console_logs.read();
                let total = logs.len();
                let limited = total > 100;
                let messages: Vec<_> = if limited {
                    logs.iter().skip(total - 100).cloned().collect()
                } else {
                    logs.iter().cloned().collect()
                };
                serde_json::json!({
                    "messages": messages,
                    "count": messages.len(),
                    "limited": limited
                })
            } else {
                serde_json::json!({ "messages": [], "count": 0, "limited": false })
            };

            Ok(serde_json::json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": serde_json::to_string_pretty(&console_data).unwrap_or_default()
                }]
            }))
        }
        _ => Err(format!("Unknown resource type: {}", resource_type)),
    }
}

async fn handle_tool_call(server: Arc<SimpleBrowserMcpServer>, params: &Value) -> Result<Value, String> {
    let tool_name = params.get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing tool name")?;

    let empty_args = Value::Object(serde_json::Map::new());
    let args = params.get("arguments").unwrap_or(&empty_args);

    let result = match tool_name {
        "get_page_content" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let include_metadata = args.get("includeMetadata").and_then(|v| v.as_bool()).unwrap_or(true);
            let include_html = args.get("includeHtml").and_then(|v| v.as_bool()).unwrap_or(false);
            let max_text_length = args.get("maxTextLength").and_then(|v| v.as_u64()).unwrap_or(30000) as usize;

            server.handle_get_page_content(tab_id, include_metadata, include_html, max_text_length).await
                .map_err(|e| format!("Failed to get page content: {}", e))?
        }
        "get_dom_snapshot" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let selector = args.get("selector").and_then(|v| v.as_str());
            let max_nodes = args.get("maxNodes").and_then(|v| v.as_u64()).unwrap_or(500) as usize;
            let include_styles = args.get("includeStyles").and_then(|v| v.as_bool()).unwrap_or(false);
            let exclude_scripts = args.get("excludeScripts").and_then(|v| v.as_bool()).unwrap_or(true);
            let exclude_styles = args.get("excludeStyles").and_then(|v| v.as_bool()).unwrap_or(true);

            server.handle_get_dom_snapshot(tab_id, selector, max_nodes, include_styles, exclude_scripts, exclude_styles).await
                .map_err(|e| format!("Failed to get DOM snapshot: {}", e))?
        }
        "execute_javascript" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let code = args.get("code").and_then(|v| v.as_str()).ok_or("Missing JavaScript code")?;

            server.handle_execute_javascript(tab_id, code.to_string()).await
                .map_err(|e| format!("Failed to execute JavaScript: {}", e))?
        }
        "get_console_messages" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let log_levels = args.get("logLevels").and_then(|v| v.as_array()).map(|arr| {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
            });
            let search_term = args.get("searchTerm").and_then(|v| v.as_str());
            let since = args.get("since").and_then(|v| v.as_f64());
            let page_size = args.get("pageSize").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let cursor = args.get("cursor").and_then(|v| v.as_str());

            server.handle_get_console_messages(tab_id, log_levels, search_term, since, page_size, cursor).await
                .map_err(|e| format!("Failed to get console messages: {}", e))?
        }
        "get_network_requests" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let method = args.get("method").and_then(|v| v.as_str());
            let status = args.get("status");
            let resource_type = args.get("resourceType").and_then(|v| v.as_str());
            let domain = args.get("domain").and_then(|v| v.as_str());
            let failed_only = args.get("failedOnly").and_then(|v| v.as_bool()).unwrap_or(false);
            let page_size = args.get("pageSize").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let cursor = args.get("cursor").and_then(|v| v.as_str());
            let include_response_bodies = args.get("includeResponseBodies").and_then(|v| v.as_bool()).unwrap_or(false);
            let include_request_bodies = args.get("includeRequestBodies").and_then(|v| v.as_bool()).unwrap_or(false);

            server.handle_get_network_requests(
                tab_id, method, status, resource_type, domain, failed_only,
                page_size, cursor, include_response_bodies, include_request_bodies
            ).await
                .map_err(|e| format!("Failed to get network requests: {}", e))?
        }
        "capture_screenshot" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let format = args.get("format").and_then(|v| v.as_str()).unwrap_or("png");
            let quality = args.get("quality").and_then(|v| v.as_f64()).unwrap_or(90.0) as f32;

            server.handle_capture_screenshot(tab_id, format, quality).await
                .map_err(|e| format!("Failed to capture screenshot: {}", e))?
        }
        "get_performance_metrics" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);

            server.handle_get_performance_metrics(tab_id).await
                .map_err(|e| format!("Failed to get performance metrics: {}", e))?
        }
        "get_accessibility_tree" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let timeout = args.get("timeout").and_then(|v| v.as_u64());

            server.handle_get_accessibility_tree(tab_id, timeout).await
                .map_err(|e| format!("Failed to get accessibility tree: {}", e))?
        }
        "get_browser_tabs" => {
            server.handle_get_browser_tabs().await
                .map_err(|e| format!("Failed to get browser tabs: {}", e))?
        }
        "attach_debugger" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64())
                .ok_or("tabId is required for debugger operations")? as u32;

            server.handle_attach_debugger(tab_id).await
                .map_err(|e| format!("Failed to attach debugger: {}", e))?
        }
        "detach_debugger" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64())
                .ok_or("tabId is required for debugger operations")? as u32;

            server.handle_detach_debugger(tab_id).await
                .map_err(|e| format!("Failed to detach debugger: {}", e))?
        }
        _ => return Err(format!("Unknown tool: {}", tool_name)),
    };

    // Wrap result in MCP tool response format
    Ok(serde_json::json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&result).unwrap_or_default()
        }]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerConfig;
    use axum_test::TestServer;

    #[tokio::test]
    async fn test_combined_server_creation() {
        let config = ServerConfig::default();
        let server = Arc::new(SimpleBrowserMcpServer::new(config).await.unwrap());

        let app = Router::new()
            .route("/mcp", post(handle_mcp_request))
            .route("/ws", get(handle_websocket_upgrade))
            .route("/health", get(handle_health_check))
            .route("/cleanup-connections", post(handle_cleanup_connections))
            .layer(CorsLayer::permissive())
            .with_state(server);

        let test_server = TestServer::new(app).unwrap();

        // Test health endpoint
        let response = test_server.get("/health").await;
        assert_eq!(response.status_code(), 200);
    }

    #[tokio::test]
    async fn test_mcp_initialize() {
        let config = ServerConfig::default();
        let server = Arc::new(SimpleBrowserMcpServer::new(config).await.unwrap());

        let app = Router::new()
            .route("/mcp", post(handle_mcp_request))
            .with_state(server);

        let test_server = TestServer::new(app).unwrap();

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        });

        let response = test_server.post("/mcp").json(&request).await;
        assert_eq!(response.status_code(), 200);

        let body: Value = response.json();
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 1);
        assert!(body["result"].is_object());
    }

    #[tokio::test]
    async fn test_tools_list_returns_11_tools() {
        let config = ServerConfig::default();
        let server = Arc::new(SimpleBrowserMcpServer::new(config).await.unwrap());

        let app = Router::new()
            .route("/mcp", post(handle_mcp_request))
            .with_state(server);

        let test_server = TestServer::new(app).unwrap();

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list"
        });

        let response = test_server.post("/mcp").json(&request).await;
        let body: Value = response.json();
        let tools = body["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 11, "Expected 11 tools, got {}", tools.len());
    }
}
