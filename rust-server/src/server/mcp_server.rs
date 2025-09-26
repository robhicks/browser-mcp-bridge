use crate::{
    cache::BrowserDataCache,
    config::ServerConfig,
    transport::{ConnectionPool, RequestHandler},
    types::{browser::*, errors::*, mcp::*, messages::*},
};
use regex::Regex;
use rmcp::{Error as McpError, ServerHandler, model::{Resource, ResourceContent, Tool}};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};

pub struct BrowserMcpServer {
    pub data_cache: Arc<BrowserDataCache>,
    pub connection_pool: Arc<ConnectionPool>,
    pub request_handler: Arc<RequestHandler>,
    pub performance_monitor: Arc<PerformanceMonitor>,
    pub config: ServerConfig,
    start_time: std::time::Instant,
}

pub struct PerformanceMonitor {
    request_counts: dashmap::DashMap<String, u64>,
    response_times: dashmap::DashMap<String, Vec<Duration>>,
    error_counts: dashmap::DashMap<String, u64>,
}

impl BrowserMcpServer {
    pub async fn new(config: ServerConfig) -> crate::types::errors::Result<Self> {
        let data_cache = Arc::new(BrowserDataCache::new(
            config.cache.max_size_mb * 1024 * 1024, // Convert to bytes
            Duration::from_secs(config.cache.data_ttl_secs),
        ));

        let connection_pool = Arc::new(ConnectionPool::new(
            Duration::from_secs(config.connections.health_check_interval_secs),
            Duration::from_secs(config.connections.websocket_timeout_secs),
        ));

        let request_handler = Arc::new(RequestHandler::new(1000));
        let performance_monitor = Arc::new(PerformanceMonitor::new());

        Ok(Self {
            data_cache,
            connection_pool,
            request_handler,
            performance_monitor,
            config,
            start_time: std::time::Instant::now(),
        })
    }

    pub async fn get_health_status(&self) -> HealthStatus {
        let uptime = self.start_time.elapsed();
        let cache_stats = self.data_cache.get_cache_stats().await;
        let connection_stats = self.connection_pool.get_stats();
        let memory_usage = self.data_cache.get_memory_usage().await;
        let request_metrics = self.request_handler.get_metrics();

        HealthStatus {
            status: "healthy".to_string(),
            timestamp: chrono::Utc::now(),
            version: "1.0.0".to_string(),
            uptime_seconds: uptime.as_secs(),
            active_connections: connection_stats
                .active_connections
                .load(std::sync::atomic::Ordering::Relaxed) as usize,
            cached_tabs: self.data_cache.get_all_tabs().await.len(),
            memory_usage_mb: memory_usage as f64 / (1024.0 * 1024.0),
            performance_stats: PerformanceStats {
                requests_per_second: self.calculate_requests_per_second(),
                average_response_time_ms: request_metrics.average_response_time.as_millis() as f64,
                cache_hit_rate: cache_stats.2, // hit rate is the third element
                error_rate: self.request_handler.get_error_rate(),
                active_websocket_connections: connection_stats
                    .active_connections
                    .load(std::sync::atomic::Ordering::Relaxed) as usize,
            },
        }
    }

    fn calculate_requests_per_second(&self) -> f64 {
        let uptime = self.start_time.elapsed();
        let total_requests = self.request_handler.get_metrics().total_requests;
        if uptime.as_secs() > 0 {
            total_requests as f64 / uptime.as_secs() as f64
        } else {
            0.0
        }
    }

    pub fn extract_tab_id(&self, args: &Value) -> Option<u32> {
        args.get("tabId")
            .or_else(|| args.get("tab_id"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
    }

    pub fn get_active_tab_id(&self) -> u32 {
        // For now, return tab 1 as default
        // In a real implementation, this would track the currently active tab
        1
    }
}

#[async_trait::async_trait]
impl ServerHandler for BrowserMcpServer {
    async fn handle_list_tools(&self) -> Result<Vec<Tool>, McpError> {
        Ok(vec![
            Tool {
                name: "get_page_content".to_string(),
                description: "Get the full content and metadata of a web page".to_string(),
                input_schema: serde_json::json!({
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
                }),
            },
            Tool {
                name: "get_dom_snapshot".to_string(),
                description: "Get a structured snapshot of the DOM tree".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
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
                }),
            },
            Tool {
                name: "execute_javascript".to_string(),
                description: "Execute JavaScript code in the browser page context".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
                        "code": {
                            "type": "string",
                            "description": "JavaScript code to execute"
                        },
                        "returnByValue": {
                            "type": "boolean",
                            "description": "Return result by value instead of reference",
                            "default": true
                        }
                    },
                    "required": ["code"]
                }),
            },
            Tool {
                name: "get_console_messages".to_string(),
                description: "Get console messages from the browser".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
                        "levelFilter": {
                            "type": "string",
                            "description": "Filter by log level (log, info, warn, error)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of messages to return",
                            "default": 100
                        }
                    }
                }),
            },
            Tool {
                name: "get_network_requests".to_string(),
                description: "Get network requests made by the browser".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
                        "includeBodies": {
                            "type": "boolean",
                            "description": "Include request/response bodies",
                            "default": false
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of requests to return",
                            "default": 50
                        }
                    }
                }),
            },
            Tool {
                name: "capture_screenshot".to_string(),
                description: "Capture a screenshot of the current page".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
                        "format": {
                            "type": "string",
                            "description": "Image format (png, jpeg)",
                            "default": "png"
                        },
                        "quality": {
                            "type": "number",
                            "description": "Image quality (0-1) for JPEG",
                            "minimum": 0,
                            "maximum": 1
                        },
                        "clip": {
                            "type": "object",
                            "description": "Clipping rectangle",
                            "properties": {
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "width": {"type": "number"},
                                "height": {"type": "number"}
                            }
                        }
                    }
                }),
            },
            Tool {
                name: "get_performance_metrics".to_string(),
                description: "Get performance metrics for the page".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        }
                    }
                }),
            },
            Tool {
                name: "get_accessibility_tree".to_string(),
                description: "Get the accessibility tree for the page".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        },
                        "maxDepth": {
                            "type": "number",
                            "description": "Maximum tree depth",
                            "default": 10
                        }
                    }
                }),
            },
            Tool {
                name: "get_browser_tabs".to_string(),
                description: "Get list of all browser tabs".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            Tool {
                name: "attach_debugger".to_string(),
                description: "Attach debugger to a browser tab".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        }
                    },
                    "required": ["tabId"]
                }),
            },
            Tool {
                name: "detach_debugger".to_string(),
                description: "Detach debugger from a browser tab".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "tabId": {
                            "type": "number",
                            "description": "Browser tab ID"
                        }
                    },
                    "required": ["tabId"]
                }),
            },
        ])
    }

    async fn handle_call_tool(&self, name: &str, arguments: Value) -> Result<Vec<McpContent>, McpError> {
        let start_time = self.request_handler.record_request_start();

        let result = match name {
            "get_page_content" => self.get_page_content(arguments).await,
            "get_dom_snapshot" => self.get_dom_snapshot(arguments).await,
            "execute_javascript" => self.execute_javascript(arguments).await,
            "get_console_messages" => self.get_console_messages(arguments).await,
            "get_network_requests" => self.get_network_requests(arguments).await,
            "capture_screenshot" => self.capture_screenshot(arguments).await,
            "get_performance_metrics" => self.get_performance_metrics(arguments).await,
            "get_accessibility_tree" => self.get_accessibility_tree(arguments).await,
            "get_browser_tabs" => self.get_browser_tabs().await,
            "attach_debugger" => self.attach_debugger(arguments).await,
            "detach_debugger" => self.detach_debugger(arguments).await,
            _ => Err(McpError::MethodNotFound(name.to_string())),
        };

        // Record performance metrics
        match &result {
            Ok(_) => {
                self.request_handler.record_request_success(start_time);
                self.performance_monitor.record_request(name, start_time.elapsed(), true);
            }
            Err(e) => {
                let browser_error = BrowserMcpError::InternalError {
                    message: e.to_string(),
                };
                self.request_handler.record_request_failure(start_time, &browser_error);
                self.performance_monitor.record_request(name, start_time.elapsed(), false);
            }
        }

        result
    }

    async fn handle_list_resources(&self) -> Result<Vec<Resource>, McpError> {
        let mut resources = Vec::new();

        // Dynamic resource discovery from cached browser data
        for tab_data in self.data_cache.get_all_tabs().await {
            if let Some(page_content) = &tab_data.page_content {
                resources.push(Resource {
                    uri: format!("browser://tab/{}/content", tab_data.tab_id),
                    name: format!("Page Content - {}", page_content.title),
                    description: Some(format!("Full page content from {}", page_content.url)),
                    mime_type: Some("text/html".to_string()),
                });
            }

            if let Some(dom_snapshot) = &tab_data.dom_snapshot {
                resources.push(Resource {
                    uri: format!("browser://tab/{}/dom", tab_data.tab_id),
                    name: format!("DOM Snapshot - {} nodes", dom_snapshot.node_count),
                    description: Some(format!("Structured DOM tree with {} nodes", dom_snapshot.node_count)),
                    mime_type: Some("application/json".to_string()),
                });
            }

            if let Some(console_logs) = &tab_data.console_logs {
                let log_count = console_logs.read().len();
                resources.push(Resource {
                    uri: format!("browser://tab/{}/console", tab_data.tab_id),
                    name: format!("Console Messages - {} messages", log_count),
                    description: Some(format!("Browser console output with {} messages", log_count)),
                    mime_type: Some("application/json".to_string()),
                });
            }
        }

        Ok(resources)
    }

    async fn handle_read_resource(&self, uri: &str) -> Result<Vec<ResourceContent>, McpError> {
        let resource_regex = Regex::new(r"^browser://tab/(\d+)/(content|dom|console)$")
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        let captures = resource_regex.captures(uri)
            .ok_or_else(|| McpError::InvalidParams(format!("Invalid resource URI: {}", uri)))?;

        let tab_id: u32 = captures[1].parse()
            .map_err(|_| McpError::InvalidParams("Invalid tab ID".to_string()))?;
        let resource_type = &captures[2];

        let tab_data = self.data_cache.get_tab_data(tab_id).await
            .ok_or_else(|| McpError::ResourceNotFound(format!("No data for tab {}", tab_id)))?;

        match resource_type {
            "content" => {
                if let Some(page_content) = &tab_data.page_content {
                    Ok(vec![ResourceContent {
                        uri: uri.to_string(),
                        mime_type: Some("text/html".to_string()),
                        text: Some(page_content.html.clone()),
                        blob: None,
                    }])
                } else {
                    Err(McpError::ResourceNotFound("No page content available".to_string()))
                }
            }
            "dom" => {
                if let Some(dom_snapshot) = &tab_data.dom_snapshot {
                    Ok(vec![ResourceContent {
                        uri: uri.to_string(),
                        mime_type: Some("application/json".to_string()),
                        text: Some(serde_json::to_string_pretty(dom_snapshot).map_err(|e| McpError::InternalError(e.to_string()))?),
                        blob: None,
                    }])
                } else {
                    Err(McpError::ResourceNotFound("No DOM snapshot available".to_string()))
                }
            }
            "console" => {
                if let Some(console_logs) = &tab_data.console_logs {
                    let logs: Vec<_> = console_logs.read().iter().cloned().collect();
                    Ok(vec![ResourceContent {
                        uri: uri.to_string(),
                        mime_type: Some("application/json".to_string()),
                        text: Some(serde_json::to_string_pretty(&logs).map_err(|e| McpError::InternalError(e.to_string()))?),
                        blob: None,
                    }])
                } else {
                    Err(McpError::ResourceNotFound("No console logs available".to_string()))
                }
            }
            _ => Err(McpError::InvalidParams(format!("Unknown resource type: {}", resource_type))),
        }
    }
}

impl PerformanceMonitor {
    pub fn new() -> Self {
        Self {
            request_counts: dashmap::DashMap::new(),
            response_times: dashmap::DashMap::new(),
            error_counts: dashmap::DashMap::new(),
        }
    }

    pub fn record_request(&self, tool_name: &str, duration: Duration, success: bool) {
        // Increment request count
        self.request_counts
            .entry(tool_name.to_string())
            .and_modify(|count| *count += 1)
            .or_insert(1);

        // Record response time
        self.response_times
            .entry(tool_name.to_string())
            .and_modify(|times| {
                times.push(duration);
                // Keep only recent measurements to prevent unbounded growth
                if times.len() > 100 {
                    times.remove(0);
                }
            })
            .or_insert_with(|| vec![duration]);

        // Record error count
        if !success {
            self.error_counts
                .entry(tool_name.to_string())
                .and_modify(|count| *count += 1)
                .or_insert(1);
        }
    }

    pub fn get_stats(&self) -> HashMap<String, (u64, Duration, u64)> {
        let mut stats = HashMap::new();

        for entry in self.request_counts.iter() {
            let tool_name = entry.key();
            let count = *entry.value();

            let avg_duration = self.response_times
                .get(tool_name)
                .map(|times| {
                    if !times.is_empty() {
                        times.iter().sum::<Duration>() / times.len() as u32
                    } else {
                        Duration::ZERO
                    }
                })
                .unwrap_or(Duration::ZERO);

            let error_count = self.error_counts
                .get(tool_name)
                .map(|count| *count)
                .unwrap_or(0);

            stats.insert(tool_name.clone(), (count, avg_duration, error_count));
        }

        stats
    }

    pub fn reset_stats(&self) {
        self.request_counts.clear();
        self.response_times.clear();
        self.error_counts.clear();
    }
}

// Tool implementations
impl BrowserMcpServer {
    pub async fn get_page_content(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let include_metadata = args.get("includeMetadata")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // Fast path: Check cache first
        if let Some(cached_content) = self.data_cache.get_page_content(tab_id).await {
            if cached_content.is_fresh(Duration::from_secs(30)) {
                return Ok(vec![self.format_page_content_response(&cached_content, include_metadata)]);
            }
        }

        // Slow path: Request from browser
        let request = BrowserRequest::GetPageContent { include_metadata };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::PageContent(content) = response {
            // Update cache
            self.data_cache.update_page_content(tab_id, content.clone()).await;
            Ok(vec![self.format_page_content_response(&content, include_metadata)])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_dom_snapshot(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let max_depth = args.get("maxDepth")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(10);
        let include_styles = args.get("includeStyles")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let request = BrowserRequest::GetDomSnapshot {
            max_depth,
            include_styles,
        };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::DomSnapshot(snapshot) = response {
            self.data_cache.update_dom_snapshot(tab_id, snapshot.clone()).await;
            let content = McpContent::json(&serde_json::to_value(&snapshot).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn execute_javascript(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let code = args.get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::InvalidParams("Missing required parameter: code".to_string()))?
            .to_string();
        let return_by_value = args.get("returnByValue")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let request = BrowserRequest::ExecuteJavaScript {
            code,
            return_by_value,
        };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::JavaScriptResult(result) = response {
            let content = McpContent::json(&serde_json::to_value(&result).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_console_messages(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let level_filter = args.get("levelFilter")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let limit = args.get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(100);

        // Try cache first
        if let Some(messages) = self.data_cache.get_console_logs(tab_id).await {
            let filtered_messages: Vec<_> = messages
                .into_iter()
                .filter(|msg| {
                    level_filter.as_ref().map_or(true, |filter| msg.level == *filter)
                })
                .take(limit)
                .collect();

            let content = McpContent::json(&serde_json::to_value(&filtered_messages).map_err(|e| McpError::InternalError(e.to_string()))?);
            return Ok(vec![content]);
        }

        // Request from browser
        let request = BrowserRequest::GetConsoleMessages {
            level_filter,
            limit: Some(limit),
        };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::ConsoleMessages(messages) = response {
            let content = McpContent::json(&serde_json::to_value(&messages).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_network_requests(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let include_bodies = args.get("includeBodies")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let limit = args.get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(50);

        // Try cache first
        if let Some(requests) = self.data_cache.get_network_requests(tab_id).await {
            let limited_requests: Vec<_> = requests.into_iter().take(limit).collect();
            let content = McpContent::json(&serde_json::to_value(&limited_requests).map_err(|e| McpError::InternalError(e.to_string()))?);
            return Ok(vec![content]);
        }

        // Request from browser
        let request = BrowserRequest::GetNetworkRequests {
            include_bodies,
            limit: Some(limit),
        };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::NetworkRequests(requests) = response {
            let content = McpContent::json(&serde_json::to_value(&requests).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn capture_screenshot(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let format = args.get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("png")
            .to_string();
        let quality = args.get("quality")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32);
        let clip = args.get("clip")
            .and_then(|v| serde_json::from_value::<BoundingBox>(v.clone()).ok());

        let request = BrowserRequest::CaptureScreenshot {
            format: format.clone(),
            quality,
            clip,
        };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::Screenshot(screenshot) = response {
            self.data_cache.update_screenshot(tab_id, screenshot.clone()).await;

            let mime_type = match format.as_str() {
                "jpeg" => "image/jpeg",
                _ => "image/png",
            };

            let content = McpContent::image(screenshot.data, mime_type);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_performance_metrics(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());

        let request = BrowserRequest::GetPerformanceMetrics;
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::PerformanceMetrics(metrics) = response {
            self.data_cache.update_performance_metrics(tab_id, metrics.clone()).await;
            let content = McpContent::json(&serde_json::to_value(&metrics).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_accessibility_tree(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = self.extract_tab_id(&args).unwrap_or_else(|| self.get_active_tab_id());
        let max_depth = args.get("maxDepth")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        let request = BrowserRequest::GetAccessibilityTree { max_depth };
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::AccessibilityTree(tree) = response {
            self.data_cache.update_accessibility_tree(tab_id, tree.clone()).await;
            let content = McpContent::json(&serde_json::to_value(&tree).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn get_browser_tabs(&self) -> Result<Vec<McpContent>, McpError> {
        let request = BrowserRequest::GetBrowserTabs;

        // For tabs, we need to send to any available connection since it's a global operation
        let connections = self.connection_pool.get_active_connections().await;
        if connections.is_empty() {
            return Err(McpError::InternalError("No active browser connections".to_string()));
        }

        // Use the first active tab we can find, or default to tab 1
        let tab_id = 1; // This should be improved to use any active connection

        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::BrowserTabs(tabs) = response {
            let content = McpContent::json(&serde_json::to_value(&tabs).map_err(|e| McpError::InternalError(e.to_string()))?);
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn attach_debugger(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = args.get("tabId")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .ok_or_else(|| McpError::InvalidParams("Missing required parameter: tabId".to_string()))?;

        let request = BrowserRequest::AttachDebugger;
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::DebuggerAttached { success } = response {
            if success {
                self.data_cache.set_debugger_attached(tab_id, true).await;
            }
            let content = McpContent::json(&serde_json::json!({
                "success": success,
                "tabId": tab_id,
                "message": if success { "Debugger attached successfully" } else { "Failed to attach debugger" }
            }));
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    pub async fn detach_debugger(&self, args: Value) -> Result<Vec<McpContent>, McpError> {
        let tab_id = args.get("tabId")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .ok_or_else(|| McpError::InvalidParams("Missing required parameter: tabId".to_string()))?;

        let request = BrowserRequest::DetachDebugger;
        let response = self.connection_pool.send_request(tab_id, request).await
            .map_err(|e| McpError::InternalError(e.to_string()))?;

        if let BrowserResponse::DebuggerDetached { success } = response {
            if success {
                self.data_cache.set_debugger_attached(tab_id, false).await;
            }
            let content = McpContent::json(&serde_json::json!({
                "success": success,
                "tabId": tab_id,
                "message": if success { "Debugger detached successfully" } else { "Failed to detach debugger" }
            }));
            Ok(vec![content])
        } else {
            Err(McpError::InternalError("Unexpected response type".to_string()))
        }
    }

    fn format_page_content_response(&self, content: &PageContent, include_metadata: bool) -> McpContent {
        let mut result = serde_json::json!({
            "url": content.url,
            "title": content.title,
            "text": content.text,
        });

        if include_metadata {
            result["html"] = Value::String(content.html.clone());
            result["metadata"] = serde_json::to_value(&content.metadata).unwrap_or(Value::Null);
        }

        McpContent::json(&result)
    }
}