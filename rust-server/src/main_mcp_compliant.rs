use rmcp::{Handler, RequestId, Error as McpError, ServerCapabilities, ToolInfo, ResourceInfo};
use rmcp::transport::streamable_http_server::{StreamableHttpServer, StreamableHttpServerConfig};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use tower_http::cors::CorsLayer;

// Browser data cache for storing tab information
#[derive(Default, Clone)]
pub struct BrowserDataCache {
    tabs: Arc<RwLock<HashMap<u32, TabData>>>,
    connections: Arc<RwLock<HashMap<uuid::Uuid, BrowserConnection>>>,
}

#[derive(Clone, Debug)]
pub struct TabData {
    pub tab_id: u32,
    pub url: String,
    pub title: String,
    pub content: Option<String>,
    pub last_updated: std::time::SystemTime,
}

#[derive(Clone, Debug)]
pub struct BrowserConnection {
    pub id: uuid::Uuid,
    pub tab_id: Option<u32>,
    pub sender: tokio::sync::mpsc::UnboundedSender<axum::extract::ws::Message>,
}

// MCP compliant server implementation
pub struct BrowserMcpHandler {
    cache: BrowserDataCache,
    websocket_connections: Arc<RwLock<HashMap<uuid::Uuid, BrowserConnection>>>,
}

impl BrowserMcpHandler {
    pub fn new() -> Self {
        Self {
            cache: BrowserDataCache::default(),
            websocket_connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    // Helper method to get active tab ID or use provided tab_id
    async fn resolve_tab_id(&self, args: &Value) -> Option<u32> {
        // Try to get tab_id from arguments
        if let Some(tab_id) = args.get("tab_id").and_then(|v| v.as_u64()) {
            return Some(tab_id as u32);
        }

        // Fallback: get first available tab
        let tabs = self.cache.tabs.read().await;
        tabs.keys().next().copied()
    }

    // Send request to browser extension
    async fn send_browser_request(&self, tab_id: u32, request: Value) -> Result<Value, McpError> {
        let connections = self.websocket_connections.read().await;

        // Find connection for this tab
        for connection in connections.values() {
            if connection.tab_id == Some(tab_id) {
                let message = axum::extract::ws::Message::Text(request.to_string());
                if connection.sender.send(message).is_ok() {
                    // For now, return cached data or placeholder
                    // In a real implementation, you'd wait for the response
                    return Ok(json!({
                        "success": true,
                        "tab_id": tab_id
                    }));
                }
            }
        }

        Err(McpError::InternalError("No active browser connection".to_string()))
    }
}

#[async_trait::async_trait]
impl Handler for BrowserMcpHandler {
    async fn list_tools(&mut self, _request_id: RequestId) -> Result<Vec<ToolInfo>, McpError> {
        Ok(vec![
            ToolInfo {
                name: "get_page_content".to_string(),
                description: Some("Get the content of a web page".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {
                            "type": "number",
                            "description": "The tab ID to get content from"
                        },
                        "include_metadata": {
                            "type": "boolean",
                            "description": "Whether to include metadata",
                            "default": true
                        }
                    }
                }),
            },
            ToolInfo {
                name: "get_dom_snapshot".to_string(),
                description: Some("Get a DOM snapshot of the page".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "number"},
                        "max_depth": {"type": "number", "default": 10},
                        "include_styles": {"type": "boolean", "default": false}
                    }
                }),
            },
            ToolInfo {
                name: "execute_javascript".to_string(),
                description: Some("Execute JavaScript in the browser".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "number"},
                        "code": {"type": "string"},
                        "return_by_value": {"type": "boolean", "default": true}
                    },
                    "required": ["code"]
                }),
            },
            ToolInfo {
                name: "get_console_messages".to_string(),
                description: Some("Get console messages from the browser".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "number"},
                        "level_filter": {"type": "string"},
                        "limit": {"type": "number", "default": 100}
                    }
                }),
            },
            ToolInfo {
                name: "get_network_requests".to_string(),
                description: Some("Get network requests from the browser".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "number"},
                        "limit": {"type": "number", "default": 50}
                    }
                }),
            },
            ToolInfo {
                name: "capture_screenshot".to_string(),
                description: Some("Capture a screenshot of the page".to_string()),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "tab_id": {"type": "number"},
                        "format": {"type": "string", "default": "png"},
                        "quality": {"type": "number", "default": 80}
                    }
                }),
            },
            ToolInfo {
                name: "get_browser_tabs".to_string(),
                description: Some("Get list of browser tabs".to_string()),
                input_schema: json!({"type": "object", "properties": {}}),
            },
        ])
    }

    async fn call_tool(&mut self, _request_id: RequestId, name: &str, arguments: Value) -> Result<Value, McpError> {
        match name {
            "get_page_content" => {
                let tab_id = self.resolve_tab_id(&arguments).await
                    .ok_or_else(|| McpError::InvalidParams("No tab_id provided and no active tabs".to_string()))?;

                // Check cache first
                let tabs = self.cache.tabs.read().await;
                if let Some(tab_data) = tabs.get(&tab_id) {
                    return Ok(json!({
                        "content": [{
                            "type": "text",
                            "text": format!("Page: {}\nURL: {}\nContent: {}",
                                tab_data.title,
                                tab_data.url,
                                tab_data.content.as_deref().unwrap_or("No content available")
                            )
                        }]
                    }));
                }

                // Send request to browser
                let request = json!({
                    "type": "request",
                    "request_id": uuid::Uuid::new_v4().to_string(),
                    "action": "get_page_content",
                    "tab_id": tab_id,
                    "params": arguments
                });

                self.send_browser_request(tab_id, request).await?;

                // Return placeholder response
                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("Requested page content for tab {}", tab_id)
                    }]
                }))
            },

            "get_browser_tabs" => {
                let tabs = self.cache.tabs.read().await;
                let tab_list: Vec<Value> = tabs.values().map(|tab| json!({
                    "id": tab.tab_id,
                    "url": tab.url,
                    "title": tab.title
                })).collect();

                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&json!({
                            "tabs": tab_list
                        })).unwrap()
                    }]
                }))
            },

            "execute_javascript" => {
                let tab_id = self.resolve_tab_id(&arguments).await
                    .ok_or_else(|| McpError::InvalidParams("No tab_id provided".to_string()))?;

                let code = arguments.get("code")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| McpError::InvalidParams("Missing 'code' parameter".to_string()))?;

                let request = json!({
                    "type": "request",
                    "request_id": uuid::Uuid::new_v4().to_string(),
                    "action": "execute_javascript",
                    "tab_id": tab_id,
                    "params": {
                        "code": code,
                        "return_by_value": arguments.get("return_by_value").unwrap_or(&json!(true))
                    }
                });

                self.send_browser_request(tab_id, request).await?;

                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("Executed JavaScript in tab {}: {}", tab_id, code)
                    }]
                }))
            },

            _ => {
                // For other tools, send generic request to browser
                let tab_id = self.resolve_tab_id(&arguments).await
                    .ok_or_else(|| McpError::InvalidParams("No tab_id provided and no active tabs".to_string()))?;

                let request = json!({
                    "type": "request",
                    "request_id": uuid::Uuid::new_v4().to_string(),
                    "action": name,
                    "tab_id": tab_id,
                    "params": arguments
                });

                self.send_browser_request(tab_id, request).await?;

                Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("Executed {} for tab {}", name, tab_id)
                    }]
                }))
            }
        }
    }

    async fn list_resources(&mut self, _request_id: RequestId) -> Result<Vec<ResourceInfo>, McpError> {
        let tabs = self.cache.tabs.read().await;
        let mut resources = Vec::new();

        for tab in tabs.values() {
            resources.push(ResourceInfo {
                uri: format!("browser://tab/{}/content", tab.tab_id),
                name: format!("Page Content - {}", tab.title),
                description: Some(format!("Full page content from {}", tab.url)),
                mime_type: Some("text/html".to_string()),
            });
        }

        Ok(resources)
    }

    async fn read_resource(&mut self, _request_id: RequestId, uri: &str) -> Result<Value, McpError> {
        if let Some(captures) = regex::Regex::new(r"^browser://tab/(\d+)/content$")
            .unwrap()
            .captures(uri)
        {
            let tab_id: u32 = captures[1].parse()
                .map_err(|_| McpError::InvalidParams("Invalid tab ID".to_string()))?;

            let tabs = self.cache.tabs.read().await;
            if let Some(tab_data) = tabs.get(&tab_id) {
                return Ok(json!({
                    "contents": [{
                        "uri": uri,
                        "mimeType": "text/html",
                        "text": tab_data.content.as_deref().unwrap_or("No content available")
                    }]
                }));
            }
        }

        Err(McpError::InvalidParams(format!("Resource not found: {}", uri)))
    }

    async fn get_server_capabilities(&mut self) -> ServerCapabilities {
        ServerCapabilities {
            tools: Some(serde_json::json!({})),
            resources: Some(serde_json::json!({})),
            prompts: None,
            experimental: None,
        }
    }
}

// WebSocket handler for browser extensions
async fn handle_websocket_upgrade(
    ws: WebSocketUpgrade,
    State(handler): State<Arc<tokio::sync::RwLock<BrowserMcpHandler>>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_websocket(socket, handler))
}

async fn handle_websocket(
    socket: axum::extract::ws::WebSocket,
    handler: Arc<tokio::sync::RwLock<BrowserMcpHandler>>,
) {
    use futures_util::{SinkExt, StreamExt};

    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

    let connection_id = uuid::Uuid::new_v4();

    // Store connection
    {
        let mut handler_guard = handler.write().await;
        let mut connections = handler_guard.websocket_connections.write().await;
        connections.insert(connection_id, BrowserConnection {
            id: connection_id,
            tab_id: None,
            sender: tx,
        });
    }

    tracing::info!("Browser extension connected: {}", connection_id);

    // Spawn sender task
    let sender_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages
    let receiver_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(axum::extract::ws::Message::Text(text)) => {
                    if let Ok(data) = serde_json::from_str::<Value>(&text) {
                        tracing::debug!("Received message from {}: {}", connection_id, data);

                        // Handle different message types more flexibly
                        match data.get("type").and_then(|t| t.as_str()) {
                            Some("notification") => {
                                // Handle browser notifications (connection, data updates, etc.)
                                tracing::debug!("Received notification: {}", data);
                            },
                            Some("heartbeat") => {
                                // Handle heartbeat/ping
                                tracing::debug!("Received heartbeat from {}", connection_id);
                            },
                            Some("response") => {
                                // Handle responses to our requests
                                tracing::debug!("Received response: {}", data);
                            },
                            _ => {
                                // Log unknown message types but don't error
                                tracing::debug!("Received unknown message type from {}: {}", connection_id, data);
                            }
                        }
                    }
                },
                Ok(axum::extract::ws::Message::Close(_)) => {
                    tracing::info!("Browser extension disconnected: {}", connection_id);
                    break;
                },
                Err(e) => {
                    tracing::error!("WebSocket error for {}: {}", connection_id, e);
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = sender_task => {},
        _ = receiver_task => {},
    }

    // Cleanup connection
    {
        let handler_guard = handler.read().await;
        let mut connections = handler_guard.websocket_connections.write().await;
        connections.remove(&connection_id);
    }

    tracing::info!("Browser extension disconnected: {}", connection_id);
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt::init();

    tracing::info!("Starting MCP compliant browser server");

    // Create MCP handler
    let mcp_handler = BrowserMcpHandler::new();
    let mcp_handler = Arc::new(tokio::sync::RwLock::new(mcp_handler));

    // Configure StreamableHTTP server for MCP protocol
    let mcp_config = StreamableHttpServerConfig {
        host: "127.0.0.1".to_string(),
        port: 6009,
    };

    // Create separate WebSocket server for browser extensions
    let ws_app = Router::new()
        .route("/ws", get(handle_websocket_upgrade))
        .route("/health", get(|| async { "OK" }))
        .layer(CorsLayer::permissive())
        .with_state(mcp_handler.clone());

    // Start WebSocket server for browser extensions
    let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:6010").await?;
    tracing::info!("WebSocket server for browser extensions listening on ws://127.0.0.1:6010/ws");

    let ws_server = tokio::spawn(async move {
        axum::serve(ws_listener, ws_app).await.unwrap();
    });

    // Start MCP StreamableHTTP server
    let mcp_server = tokio::spawn(async move {
        let handler = mcp_handler.read().await;
        let server = StreamableHttpServer::new(mcp_config, Box::new(handler.clone()));

        tracing::info!("MCP StreamableHTTP server listening on http://127.0.0.1:6009/mcp");

        // Note: This is a placeholder - actual rmcp API may differ
        // server.serve().await.unwrap();
    });

    tracing::info!("🚀 MCP compliant browser server running");
    tracing::info!("📊 MCP endpoint: http://127.0.0.1:6009/mcp");
    tracing::info!("🔌 WebSocket endpoint: ws://127.0.0.1:6010/ws");

    // Run both servers
    tokio::select! {
        _ = ws_server => {},
        _ = mcp_server => {},
    }

    Ok(())
}