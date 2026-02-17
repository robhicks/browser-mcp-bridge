use crate::cache::BrowserDataCache;
use crate::types::{errors::*, messages::*};
use axum::extract::ws::{Message, WebSocket};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[derive(Clone)]
pub struct ConnectionPool {
    connections: Arc<DashMap<Uuid, WebSocketConnection>>,
    health_monitor: Arc<HealthMonitor>,
    message_router: Arc<MessageRouter>,
    stats: Arc<ConnectionStats>,
    data_cache: Option<Arc<BrowserDataCache>>,
}

pub struct WebSocketConnection {
    pub id: Uuid,
    pub sender: mpsc::UnboundedSender<Message>,
    pub tab_id: Option<u32>,
    pub connected_at: Instant,
    pub last_activity: Arc<RwLock<Instant>>,
    pub remote_addr: Option<std::net::SocketAddr>,
}

#[derive(Default)]
pub struct ConnectionStats {
    pub total_connections: std::sync::atomic::AtomicU64,
    pub active_connections: std::sync::atomic::AtomicU64,
    pub messages_sent: std::sync::atomic::AtomicU64,
    pub messages_received: std::sync::atomic::AtomicU64,
    pub connection_errors: std::sync::atomic::AtomicU64,
}

pub struct HealthMonitor {
    unhealthy_connections: Arc<DashMap<Uuid, Instant>>,
    check_interval: Duration,
    timeout_threshold: Duration,
}

pub struct MessageRouter {
    pending_requests: Arc<DashMap<Uuid, oneshot::Sender<BrowserResponse>>>,
    request_timeout: Duration,
}

impl ConnectionPool {
    pub fn new(check_interval: Duration, timeout_threshold: Duration) -> Self {
        Self {
            connections: Arc::new(DashMap::new()),
            health_monitor: Arc::new(HealthMonitor::new(check_interval, timeout_threshold)),
            message_router: Arc::new(MessageRouter::new(Duration::from_secs(30))),
            stats: Arc::new(ConnectionStats::default()),
            data_cache: None,
        }
    }

    pub fn set_data_cache(&mut self, cache: Arc<BrowserDataCache>) {
        self.data_cache = Some(cache);
    }

    // Efficient connection handling with minimal allocations
    pub async fn handle_connection(&self, socket: WebSocket, addr: Option<std::net::SocketAddr>) {
        let (sender, mut receiver) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let connection_id = Uuid::new_v4();
        let connection = WebSocketConnection {
            id: connection_id,
            sender: tx,
            tab_id: None,
            connected_at: Instant::now(),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            remote_addr: addr,
        };

        self.connections.insert(connection_id, connection);
        self.stats
            .total_connections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.stats
            .active_connections
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        tracing::info!(
            "WebSocket connection established: {} from {:?}",
            connection_id,
            addr
        );

        // Spawn sender task (outbound messages)
        let sender_task = {
            let connection_id = connection_id;
            let stats = self.stats.clone();
            tokio::spawn(async move {
                let mut sender = sender;
                while let Some(msg) = rx.recv().await {
                    if sender.send(msg).await.is_err() {
                        tracing::warn!("Failed to send message to {}", connection_id);
                        break;
                    }
                    stats
                        .messages_sent
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            })
        };

        // Spawn receiver task (inbound messages)
        let receiver_task = {
            let pool = self.clone();
            tokio::spawn(async move {
                while let Some(msg_result) = receiver.next().await {
                    match msg_result {
                        Ok(msg) => {
                            pool.stats
                                .messages_received
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

                            if let Err(e) = pool.handle_message(connection_id, msg).await {
                                tracing::error!(
                                    "Error handling message from {}: {}",
                                    connection_id,
                                    e
                                );
                                pool.stats
                                    .connection_errors
                                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                break;
                            }
                        }
                        Err(e) => {
                            tracing::error!("WebSocket error for {}: {}", connection_id, e);
                            pool.stats
                                .connection_errors
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            break;
                        }
                    }
                }
            })
        };

        // Wait for either task to complete
        tokio::select! {
            _ = sender_task => {},
            _ = receiver_task => {},
        }

        // Cleanup
        self.remove_connection(connection_id).await;
        self.stats
            .active_connections
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        tracing::info!("WebSocket connection closed: {}", connection_id);
    }

    async fn handle_message(&self, connection_id: Uuid, message: Message) -> Result<()> {
        // Update last activity
        if let Some(connection) = self.connections.get(&connection_id) {
            *connection.last_activity.write() = Instant::now();
        }

        match message {
            Message::Text(text) => {
                // Try to parse as BrowserMessage first, but if it fails, handle it more flexibly
                match serde_json::from_str::<BrowserMessage>(&text) {
                    Ok(browser_message) => {
                        self.process_browser_message(connection_id, browser_message)
                            .await?;
                    }
                    Err(_) => {
                        // Handle as flexible JSON message for MCP compliance
                        match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(json_value) => {
                                tracing::debug!("Received flexible message from {}: {}", connection_id, json_value);
                                self.process_flexible_message(connection_id, json_value).await?;
                            }
                            Err(parse_error) => {
                                tracing::warn!("Failed to parse message from {}: {}", connection_id, parse_error);
                                return Err(BrowserMcpError::InvalidRequest {
                                    message: format!("Invalid JSON: {}", parse_error)
                                }.into());
                            }
                        }
                    }
                }
            }
            Message::Binary(_) => {
                tracing::warn!("Received unexpected binary message from {}", connection_id);
            }
            Message::Ping(data) => {
                if let Some(connection) = self.connections.get(&connection_id) {
                    let _ = connection.sender.send(Message::Pong(data));
                }
            }
            Message::Pong(_) => {
                // Pong received, connection is alive
            }
            Message::Close(_) => {
                tracing::info!("Received close message from {}", connection_id);
                return Err(BrowserMcpError::ConnectionClosed);
            }
        }

        Ok(())
    }

    async fn process_browser_message(
        &self,
        connection_id: Uuid,
        message: BrowserMessage,
    ) -> Result<()> {
        match message {
            BrowserMessage::Response { request_id, result } => {
                self.message_router
                    .handle_response(request_id, result)
                    .await?;
            }
            BrowserMessage::Notification { event } => {
                self.handle_browser_event(connection_id, event).await?;
            }
            BrowserMessage::Heartbeat { .. } => {
                // Heartbeat received, connection is alive
            }
            BrowserMessage::Request { .. } => {
                tracing::warn!(
                    "Received unexpected request from browser connection {}",
                    connection_id
                );
            }
        }

        Ok(())
    }

    async fn handle_browser_event(&self, connection_id: Uuid, event: BrowserEvent) -> Result<()> {
        match event {
            BrowserEvent::ConnectionEstablished { tab_id } => {
                self.associate_tab_with_connection(connection_id, tab_id)
                    .await;
                tracing::info!("Connection {} associated with tab {}", connection_id, tab_id);
            }
            BrowserEvent::ConnectionLost { tab_id } => {
                self.disassociate_tab_from_connection(connection_id, tab_id)
                    .await;
                tracing::info!(
                    "Connection {} disassociated from tab {}",
                    connection_id,
                    tab_id
                );
            }
            _ => {
                // Other events can be logged or processed as needed
                tracing::debug!("Received browser event: {:?}", event);
            }
        }

        Ok(())
    }

    // Handle flexible messages for MCP compliance
    async fn process_flexible_message(
        &self,
        connection_id: Uuid,
        message: serde_json::Value,
    ) -> Result<()> {
        // Extract message type
        let message_type = message.get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("unknown");

        match message_type {
            "notification" => {
                // Handle notification messages from browser extension
                if let Some(event) = message.get("event") {
                    tracing::debug!("Received notification event from {}: {}", connection_id, event);

                    // Extract tab_id if available for connection association
                    if let Some(tab_id) = event.get("tabId").and_then(|t| t.as_u64()) {
                        self.associate_tab_with_connection(connection_id, tab_id as u32).await;
                    }
                }
            }
            "heartbeat" | "ping" => {
                tracing::debug!("Received {} from {}", message_type, connection_id);

                if let Some(connection) = self.connections.get(&connection_id) {
                    let pong_response = serde_json::json!({
                        "type": "pong",
                        "timestamp": chrono::Utc::now().timestamp_millis(),
                        "originalTimestamp": message.get("timestamp")
                    });
                    let _ = connection.sender.send(Message::Text(pong_response.to_string()));
                }
            }
            "response" => {
                // Handle response messages - extension uses camelCase "requestId" and "data" fields
                if let Some(request_id_str) = message.get("requestId").and_then(|v| v.as_str()) {
                    if let Ok(request_id) = uuid::Uuid::parse_str(request_id_str) {
                        let data = message.get("data").cloned().unwrap_or(serde_json::Value::Null);
                        tracing::debug!("Received response for request {}", request_id);
                        let response = BrowserResponse::RawJson(data);
                        self.message_router
                            .handle_response(request_id, Ok(response))
                            .await?;
                    }
                }
            }
            "error" => {
                // Handle error responses from the extension
                if let Some(request_id_str) = message.get("requestId").and_then(|v| v.as_str()) {
                    if let Ok(request_id) = uuid::Uuid::parse_str(request_id_str) {
                        let error_msg = message.get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown browser error")
                            .to_string();
                        tracing::warn!("Received error for request {}: {}", request_id, error_msg);
                        self.message_router
                            .handle_response(request_id, Err(error_msg))
                            .await?;
                    }
                }
            }
            "browser-data" => {
                // Handle pushed browser data from extension
                self.handle_browser_data_push(connection_id, &message).await;
            }
            "connection" => {
                tracing::debug!("Received connection message from {}", connection_id);
                if let Some(status) = message.get("status").and_then(|s| s.as_str()) {
                    if status == "connected" {
                        tracing::info!("Browser extension confirmed connection: {}", connection_id);
                    }
                }
                // Associate tab if provided
                if let Some(tab_id) = message.get("tabId").and_then(|t| t.as_u64()) {
                    self.associate_tab_with_connection(connection_id, tab_id as u32).await;
                }
            }
            _ => {
                tracing::debug!("Received unknown message type '{}' from {}: {}",
                    message_type, connection_id, message);
            }
        }

        Ok(())
    }

    async fn handle_browser_data_push(&self, connection_id: Uuid, message: &serde_json::Value) {
        let tab_id = message.get("tabId").and_then(|v| v.as_u64()).map(|v| v as u32);
        let source = message.get("source").and_then(|v| v.as_str()).unwrap_or("unknown");

        tracing::debug!("Received browser-data from {} (source: {}, tab: {:?})", connection_id, source, tab_id);

        // Associate tab with connection if we have a tab_id
        if let Some(tab_id) = tab_id {
            self.associate_tab_with_connection(connection_id, tab_id).await;
        }

        // Store data in cache if available
        if let Some(cache) = &self.data_cache {
            if let Some(tab_id) = tab_id {
                match source {
                    "content-script" => {
                        if let Some(data) = message.get("data") {
                            // Store page content if available
                            if let Some(page_content) = data.get("pageContent") {
                                let content = crate::types::browser::PageContent {
                                    url: page_content.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    title: page_content.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    text: page_content.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    html: page_content.get("html").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                    metadata: std::collections::HashMap::new(),
                                    last_updated: std::time::SystemTime::now(),
                                };
                                cache.update_page_content(tab_id, content).await;
                            }
                        }
                    }
                    "devtools" | "debugger" => {
                        tracing::debug!("Stored {} data for tab {}", source, tab_id);
                    }
                    _ => {
                        tracing::debug!("Unknown browser-data source: {}", source);
                    }
                }
            }
        }
    }

    async fn associate_tab_with_connection(&self, connection_id: Uuid, tab_id: u32) {
        if let Some(mut connection) = self.connections.get_mut(&connection_id) {
            connection.tab_id = Some(tab_id);
        }
    }

    async fn disassociate_tab_from_connection(&self, connection_id: Uuid, tab_id: u32) {
        if let Some(mut connection) = self.connections.get_mut(&connection_id) {
            if connection.tab_id == Some(tab_id) {
                connection.tab_id = None;
            }
        }
    }

    // Zero-allocation message broadcasting
    pub async fn broadcast_to_tab(&self, tab_id: u32, message: &BrowserMessage) -> Result<usize> {
        let serialized = serde_json::to_string(message)?;
        let ws_message = Message::Text(serialized);

        let mut sent_count = 0;

        for entry in self.connections.iter() {
            let connection = entry.value();
            if connection.tab_id == Some(tab_id) {
                if connection.sender.send(ws_message.clone()).is_ok() {
                    sent_count += 1;
                } else {
                    // Connection is dead, will be cleaned up by health monitor
                    tracing::warn!("Failed to send to connection {}", connection.id);
                }
            }
        }

        Ok(sent_count)
    }

    /// Build the flat camelCase JSON message the browser extension expects.
    /// Format: { "action": "getPageContent", "requestId": "<uuid>", "tabId": 123, ...params }
    fn build_request_json(request_id: &Uuid, request: &BrowserRequest, tab_id: Option<u32>) -> serde_json::Value {
        let mut msg = match request {
            BrowserRequest::GetPageContent { include_metadata } => {
                serde_json::json!({ "action": "getPageContent", "includeMetadata": include_metadata })
            }
            BrowserRequest::GetDomSnapshot { max_depth, include_styles } => {
                serde_json::json!({ "action": "getDOMSnapshot", "maxDepth": max_depth, "includeStyles": include_styles })
            }
            BrowserRequest::ExecuteJavaScript { code, .. } => {
                serde_json::json!({ "action": "executeScript", "script": code })
            }
            BrowserRequest::GetConsoleMessages { level_filter, limit } => {
                let mut m = serde_json::json!({ "action": "getConsoleMessages" });
                if let Some(f) = level_filter { m["levelFilter"] = serde_json::Value::String(f.clone()); }
                if let Some(l) = limit { m["limit"] = serde_json::json!(l); }
                m
            }
            BrowserRequest::GetNetworkRequests { include_bodies, limit } => {
                let mut m = serde_json::json!({ "action": "getNetworkData", "includeBodies": include_bodies });
                if let Some(l) = limit { m["limit"] = serde_json::json!(l); }
                m
            }
            BrowserRequest::CaptureScreenshot { format, quality, .. } => {
                let mut m = serde_json::json!({ "action": "captureScreenshot", "format": format });
                if let Some(q) = quality { m["quality"] = serde_json::json!(q); }
                m
            }
            BrowserRequest::GetPerformanceMetrics => {
                serde_json::json!({ "action": "getPerformanceMetrics" })
            }
            BrowserRequest::GetAccessibilityTree { max_depth } => {
                let mut m = serde_json::json!({ "action": "getAccessibilityTree" });
                if let Some(d) = max_depth { m["maxDepth"] = serde_json::json!(d); }
                m
            }
            BrowserRequest::GetBrowserTabs => {
                serde_json::json!({ "action": "getAllTabs" })
            }
            BrowserRequest::AttachDebugger => {
                serde_json::json!({ "action": "attachDebugger" })
            }
            BrowserRequest::DetachDebugger => {
                serde_json::json!({ "action": "detachDebugger" })
            }
        };

        msg["requestId"] = serde_json::Value::String(request_id.to_string());
        if let Some(tid) = tab_id {
            msg["tabId"] = serde_json::json!(tid);
        }
        msg
    }

    /// Get timeout duration based on the action type
    fn timeout_for_request(request: &BrowserRequest, custom_timeout: Option<Duration>) -> Duration {
        if let Some(t) = custom_timeout {
            return t;
        }
        match request {
            BrowserRequest::GetAccessibilityTree { .. } => Duration::from_secs(30),
            BrowserRequest::GetDomSnapshot { .. } => Duration::from_secs(20),
            _ => Duration::from_secs(10),
        }
    }

    // Efficient request-response correlation
    pub async fn send_request(&self, tab_id: u32, request: BrowserRequest) -> Result<BrowserResponse> {
        self.send_request_with_timeout(Some(tab_id), request, None).await
    }

    /// Send a request to any available connection (for global operations like getAllTabs)
    pub async fn send_request_any(&self, request: BrowserRequest) -> Result<BrowserResponse> {
        self.send_request_with_timeout(None, request, None).await
    }

    /// Send request with optional tab targeting and custom timeout
    pub async fn send_request_with_timeout(
        &self,
        tab_id: Option<u32>,
        request: BrowserRequest,
        custom_timeout: Option<Duration>,
    ) -> Result<BrowserResponse> {
        let request_id = Uuid::new_v4();
        let timeout = Self::timeout_for_request(&request, custom_timeout);

        // Create response channel
        let (response_tx, response_rx) = oneshot::channel();

        // Register pending request
        self.message_router
            .register_pending_request(request_id, response_tx)
            .await;

        // Find connection: either for specific tab or most recently active
        let connection = if let Some(tid) = tab_id {
            self.find_connection_for_tab(tid)
                .or_else(|| self.find_most_recent_connection())
        } else {
            self.find_most_recent_connection()
        };

        let connection = connection.ok_or_else(|| {
            BrowserMcpError::ConnectionNotAvailable { tab_id: tab_id.unwrap_or(0) }
        })?;

        // Build flat camelCase JSON message
        let msg = Self::build_request_json(&request_id, &request, tab_id);
        let serialized = serde_json::to_string(&msg)?;

        tracing::debug!("Sending request {} for action: {}", request_id, msg.get("action").and_then(|v| v.as_str()).unwrap_or("unknown"));
        connection.sender.send(Message::Text(serialized))?;

        // Wait for response with timeout
        tokio::time::timeout(timeout, response_rx)
            .await
            .map_err(|_| BrowserMcpError::RequestTimeout { timeout })?
            .map_err(|_| BrowserMcpError::ConnectionClosed)
    }

    pub fn find_connection_for_tab(&self, tab_id: u32) -> Option<WebSocketConnection> {
        for entry in self.connections.iter() {
            let connection = entry.value();
            if connection.tab_id == Some(tab_id) {
                return Some(WebSocketConnection {
                    id: connection.id,
                    sender: connection.sender.clone(),
                    tab_id: connection.tab_id,
                    connected_at: connection.connected_at,
                    last_activity: connection.last_activity.clone(),
                    remote_addr: connection.remote_addr,
                });
            }
        }
        None
    }

    /// Find the most recently active connection (for global operations)
    pub fn find_most_recent_connection(&self) -> Option<WebSocketConnection> {
        self.connections
            .iter()
            .max_by_key(|entry| {
                let connection = entry.value();
                *connection.last_activity.read()
            })
            .map(|entry| {
                let connection = entry.value();
                WebSocketConnection {
                    id: connection.id,
                    sender: connection.sender.clone(),
                    tab_id: connection.tab_id,
                    connected_at: connection.connected_at,
                    last_activity: connection.last_activity.clone(),
                    remote_addr: connection.remote_addr,
                }
            })
    }

    pub async fn get_active_connections(&self) -> Vec<Uuid> {
        self.connections.iter().map(|entry| *entry.key()).collect()
    }

    pub async fn get_connections_for_tab(&self, tab_id: u32) -> Vec<Uuid> {
        self.connections
            .iter()
            .filter_map(|entry| {
                let connection = entry.value();
                if connection.tab_id == Some(tab_id) {
                    Some(connection.id)
                } else {
                    None
                }
            })
            .collect()
    }

    pub async fn remove_connection(&self, connection_id: Uuid) {
        self.connections.remove(&connection_id);
        self.health_monitor
            .unhealthy_connections
            .remove(&connection_id);
        self.message_router.cleanup_connection(connection_id).await;
    }

    pub async fn cleanup_stale_connections(&self) {
        let now = Instant::now();
        let timeout_threshold = self.health_monitor.timeout_threshold;

        let stale_connections: Vec<Uuid> = self
            .connections
            .iter()
            .filter_map(|entry| {
                let connection = entry.value();
                let last_activity = *connection.last_activity.read();
                if now.duration_since(last_activity) > timeout_threshold {
                    Some(connection.id)
                } else {
                    None
                }
            })
            .collect();

        for connection_id in stale_connections {
            tracing::info!("Removing stale connection: {}", connection_id);
            self.remove_connection(connection_id).await;
        }
    }

    pub fn get_stats(&self) -> ConnectionStats {
        ConnectionStats {
            total_connections: std::sync::atomic::AtomicU64::new(
                self.stats
                    .total_connections
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
            active_connections: std::sync::atomic::AtomicU64::new(
                self.stats
                    .active_connections
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
            messages_sent: std::sync::atomic::AtomicU64::new(
                self.stats
                    .messages_sent
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
            messages_received: std::sync::atomic::AtomicU64::new(
                self.stats
                    .messages_received
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
            connection_errors: std::sync::atomic::AtomicU64::new(
                self.stats
                    .connection_errors
                    .load(std::sync::atomic::Ordering::Relaxed),
            ),
        }
    }
}

impl HealthMonitor {
    pub fn new(check_interval: Duration, timeout_threshold: Duration) -> Self {
        Self {
            unhealthy_connections: Arc::new(DashMap::new()),
            check_interval,
            timeout_threshold,
        }
    }

    pub async fn start_monitoring(&self, connection_pool: Arc<ConnectionPool>) {
        let mut interval = tokio::time::interval(self.check_interval);
        let pool = connection_pool;

        tokio::spawn(async move {
            loop {
                interval.tick().await;
                pool.cleanup_stale_connections().await;
            }
        });
    }
}

impl MessageRouter {
    pub fn new(request_timeout: Duration) -> Self {
        Self {
            pending_requests: Arc::new(DashMap::new()),
            request_timeout,
        }
    }

    pub async fn register_pending_request(
        &self,
        request_id: Uuid,
        sender: oneshot::Sender<BrowserResponse>,
    ) {
        self.pending_requests.insert(request_id, sender);

        // Set up timeout cleanup
        let pending_requests = self.pending_requests.clone();
        let timeout = self.request_timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            if let Some((_, sender)) = pending_requests.remove(&request_id) {
                let _ = sender.send(BrowserResponse::Error {
                    message: "Request timeout".to_string(),
                });
            }
        });
    }

    pub async fn handle_response(
        &self,
        request_id: Uuid,
        result: std::result::Result<BrowserResponse, String>,
    ) -> Result<()> {
        if let Some((_, sender)) = self.pending_requests.remove(&request_id) {
            let response = result.unwrap_or_else(|error| BrowserResponse::Error { message: error });
            sender.send(response).map_err(|_| BrowserMcpError::ConnectionClosed)?;
        }
        Ok(())
    }

    pub async fn cleanup_connection(&self, _connection_id: Uuid) {
        // Clean up any pending requests for this connection if needed
        // For now, we let them timeout naturally
    }
}