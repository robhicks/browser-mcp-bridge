use crate::server::SimpleBrowserMcpServer;
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
        .layer(CorsLayer::permissive())
        .with_state(mcp_handler);

    let addr = format!("{}:{}", host, port);
    let listener = TcpListener::bind(&addr).await?;

    tracing::info!("Combined HTTP/WebSocket server listening on {}", addr);
    tracing::info!("  MCP endpoint: POST http://{}/mcp", addr);
    tracing::info!("  WebSocket endpoint: GET ws://{}/ws", addr);
    tracing::info!("  Health check: GET http://{}/health", addr);

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
            // Notifications don't require a response
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

// MCP JSON-RPC handlers

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
                "description": "Get the full content and metadata of a web page",
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
                        }
                    }
                }
            },
            {
                "name": "get_dom_snapshot",
                "description": "Get a structured snapshot of the DOM tree",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tabId": { "type": "number", "description": "Browser tab ID" },
                        "maxDepth": {
                            "type": "number",
                            "description": "Maximum DOM tree depth",
                            "default": 10
                        },
                        "includeStyles": {
                            "type": "boolean",
                            "description": "Include computed styles",
                            "default": false
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
                "name": "get_browser_tabs",
                "description": "Get information about all open browser tabs",
                "inputSchema": {
                    "type": "object",
                    "properties": {}
                }
            }
        ]
    }))
}

async fn handle_resources_list(_server: Arc<SimpleBrowserMcpServer>) -> Result<Value, String> {
    // For now, return empty resources list
    // TODO: Implement dynamic resource discovery based on cached browser data
    Ok(serde_json::json!({
        "resources": []
    }))
}

async fn handle_resource_read(_server: Arc<SimpleBrowserMcpServer>, _params: &Value) -> Result<Value, String> {
    // TODO: Implement resource reading
    Err("Resource reading not yet implemented".to_string())
}

async fn handle_tool_call(server: Arc<SimpleBrowserMcpServer>, params: &Value) -> Result<Value, String> {
    let tool_name = params.get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing tool name")?;

    let empty_args = Value::Object(serde_json::Map::new());
    let args = params.get("arguments").unwrap_or(&empty_args);

    match tool_name {
        "get_page_content" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let include_metadata = args.get("includeMetadata")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            match server.handle_get_page_content(tab_id, include_metadata).await {
                Ok(result) => Ok(serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                    }]
                })),
                Err(e) => Err(format!("Failed to get page content: {}", e)),
            }
        }
        "execute_javascript" => {
            let tab_id = args.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
            let code = args.get("code")
                .and_then(|v| v.as_str())
                .ok_or("Missing JavaScript code")?;

            match server.handle_execute_javascript(tab_id, code.to_string()).await {
                Ok(result) => Ok(serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                    }]
                })),
                Err(e) => Err(format!("Failed to execute JavaScript: {}", e)),
            }
        }
        "get_browser_tabs" => {
            match server.handle_get_browser_tabs().await {
                Ok(result) => Ok(serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&result).unwrap_or_default()
                    }]
                })),
                Err(e) => Err(format!("Failed to get browser tabs: {}", e)),
            }
        }
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
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
}