use crate::{
    cache::BrowserDataCache,
    config::ServerConfig,
    transport::ConnectionPool,
    types::{errors::*, messages::*},
    utils::{self, pagination::PaginationCursors, truncation},
};
use std::{sync::Arc, time::Duration};

/// Simplified server implementation for compatibility testing
pub struct SimpleBrowserMcpServer {
    pub data_cache: Arc<BrowserDataCache>,
    pub connection_pool: Arc<ConnectionPool>,
    pub config: ServerConfig,
    pub pagination_cursors: Arc<PaginationCursors>,
    start_time: std::time::Instant,
}

impl SimpleBrowserMcpServer {
    pub async fn new(config: ServerConfig) -> crate::types::errors::Result<Self> {
        let data_cache = Arc::new(BrowserDataCache::new(
            config.cache.max_size_mb * 1024 * 1024, // Convert to bytes
            Duration::from_secs(config.cache.data_ttl_secs),
        ));

        let mut connection_pool = ConnectionPool::new(
            Duration::from_secs(config.connections.health_check_interval_secs),
            Duration::from_secs(config.connections.websocket_timeout_secs),
        );
        connection_pool.set_data_cache(data_cache.clone());
        let connection_pool = Arc::new(connection_pool);

        Ok(Self {
            data_cache,
            connection_pool,
            config,
            pagination_cursors: Arc::new(PaginationCursors::new()),
            start_time: std::time::Instant::now(),
        })
    }

    /// Extract the raw JSON data from a BrowserResponse, handling both RawJson and typed variants.
    fn extract_response_data(response: BrowserResponse) -> Result<serde_json::Value> {
        match response {
            BrowserResponse::RawJson(data) => Ok(data),
            BrowserResponse::Error { message } => Err(BrowserMcpError::BrowserExtensionError { message }),
            other => {
                // Serialize typed responses to JSON value
                serde_json::to_value(&other).map_err(|e| BrowserMcpError::JsonError {
                    message: e.to_string(),
                })
            }
        }
    }

    // ─── get_page_content ─────────────────────────────────────────────────

    pub async fn handle_get_page_content(
        &self,
        tab_id: Option<u32>,
        include_metadata: bool,
        include_html: bool,
        max_text_length: usize,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetPageContent { include_metadata };
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let page_content = Self::extract_response_data(response)?;

        // Truncate text content
        let text = page_content.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let original_text_size = text.len();
        let (text_result, text_truncated) = truncation::truncate_string(text, max_text_length);

        // Truncate HTML if included
        let mut html = None;
        let mut html_truncated = false;
        if include_html {
            if let Some(raw_html) = page_content.get("html").and_then(|v| v.as_str()) {
                let (h, t) = truncation::truncate_string(raw_html, truncation::MAX_HTML_SIZE);
                html = Some(h);
                html_truncated = t;
            }
        }

        let mut result = serde_json::json!({
            "url": page_content.get("url"),
            "title": page_content.get("title"),
            "text": text_result,
            "textTruncated": text_truncated,
            "originalTextSize": original_text_size,
        });

        if let Some(h) = html {
            result["html"] = serde_json::Value::String(h);
            result["htmlTruncated"] = serde_json::json!(html_truncated);
        }

        if include_metadata {
            if let Some(metadata) = page_content.get("metadata") {
                result["metadata"] = metadata.clone();
            }
        }

        Ok(result)
    }

    // ─── get_dom_snapshot ─────────────────────────────────────────────────

    pub async fn handle_get_dom_snapshot(
        &self,
        tab_id: Option<u32>,
        selector: Option<&str>,
        max_nodes: usize,
        include_styles: bool,
        exclude_scripts: bool,
        exclude_styles: bool,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetDomSnapshot {
            max_depth: 10,
            include_styles,
        };
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let dom_data = Self::extract_response_data(response)?;

        let mut processed_root = dom_data.get("root").cloned().unwrap_or(dom_data.clone());
        let original_node_count = dom_data.get("nodeCount").and_then(|v| v.as_u64()).unwrap_or(0);

        // Apply selector filter
        if let Some(sel) = selector {
            if let Some(found) = utils::dom::filter_dom_by_selector(&processed_root, sel) {
                processed_root = found;
            } else {
                return Ok(serde_json::json!({
                    "error": format!("No element found matching selector: {}", sel),
                    "selector": sel,
                    "message": "Try a different selector or omit to get full DOM"
                }));
            }
        }

        // Filter out scripts and styles
        if exclude_scripts || exclude_styles {
            if let Some(filtered) = utils::dom::filter_dom_tree(&processed_root, exclude_scripts, exclude_styles) {
                processed_root = filtered;
            }
        }

        // Truncate DOM tree to max_nodes (capped at 2000)
        let effective_max = max_nodes.min(2000);
        let mut node_count = 0;
        processed_root = utils::dom::truncate_dom_tree(&processed_root, effective_max, &mut node_count);
        let was_truncated = node_count >= effective_max;

        // Remove styles if not requested
        if !include_styles {
            utils::dom::remove_styles_from_dom_tree(&mut processed_root);
        }

        let message = if was_truncated {
            format!(
                "DOM tree truncated to {} nodes (original: {} nodes). Use selector to target specific elements or increase maxNodes.",
                effective_max, original_node_count
            )
        } else if selector.is_some() {
            format!("Showing subtree for selector '{}' ({} nodes)", selector.unwrap_or(""), node_count)
        } else {
            format!("Showing complete DOM tree ({} nodes)", node_count)
        };

        Ok(serde_json::json!({
            "root": processed_root,
            "nodeCount": node_count,
            "originalNodeCount": original_node_count,
            "truncated": was_truncated,
            "filters": {
                "selector": selector,
                "maxNodes": effective_max,
                "excludeScripts": exclude_scripts,
                "excludeStyles": exclude_styles
            },
            "message": message
        }))
    }

    // ─── execute_javascript ───────────────────────────────────────────────

    pub async fn handle_execute_javascript(&self, tab_id: Option<u32>, code: String) -> Result<serde_json::Value> {
        let request = BrowserRequest::ExecuteJavaScript {
            code,
            return_by_value: true,
        };

        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let data = Self::extract_response_data(response)?;
        Ok(serde_json::json!({ "result": data }))
    }

    // ─── get_console_messages ─────────────────────────────────────────────

    pub async fn handle_get_console_messages(
        &self,
        tab_id: Option<u32>,
        log_levels: Option<Vec<String>>,
        search_term: Option<&str>,
        since: Option<f64>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetConsoleMessages {
            level_filter: None,
            limit: None,
        };
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let raw_data = Self::extract_response_data(response)?;

        // Convert to array
        let messages = if let Some(arr) = raw_data.as_array() {
            arr.clone()
        } else if let Some(arr) = raw_data.get("messages").and_then(|v| v.as_array()) {
            arr.clone()
        } else {
            vec![raw_data]
        };

        // Apply filters
        let default_levels = vec!["error".to_string(), "warn".to_string()];
        let levels = log_levels.as_deref().unwrap_or(&default_levels);
        let filtered = utils::filtering::filter_console_messages(
            &messages,
            Some(levels),
            search_term,
            since,
        );

        // Apply pagination
        let effective_page_size = page_size.min(200);
        let paginated = self.pagination_cursors.paginate(filtered, cursor, effective_page_size);

        let message = if paginated.total == 0 {
            "No messages match the specified filters".to_string()
        } else if paginated.has_more {
            format!("Showing {} of {} messages. Use nextCursor to get more.", paginated.data.len(), paginated.total)
        } else {
            format!("Showing all {} matching messages", paginated.total)
        };

        Ok(serde_json::json!({
            "messages": paginated.data,
            "count": paginated.data.len(),
            "total": paginated.total,
            "hasMore": paginated.has_more,
            "nextCursor": paginated.next_cursor,
            "filters": {
                "logLevels": levels,
                "searchTerm": search_term,
                "since": since
            },
            "message": message
        }))
    }

    // ─── get_network_requests ─────────────────────────────────────────────

    pub async fn handle_get_network_requests(
        &self,
        tab_id: Option<u32>,
        method: Option<&str>,
        status: Option<&serde_json::Value>,
        resource_type: Option<&str>,
        domain: Option<&str>,
        failed_only: bool,
        page_size: usize,
        cursor: Option<&str>,
        include_response_bodies: bool,
        include_request_bodies: bool,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetNetworkRequests {
            include_bodies: false,
            limit: None,
        };
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let raw_data = Self::extract_response_data(response)?;

        // Convert to array
        let requests_arr = if let Some(arr) = raw_data.as_array() {
            arr.clone()
        } else if let Some(arr) = raw_data.get("requests").and_then(|v| v.as_array()) {
            arr.clone()
        } else {
            vec![raw_data]
        };

        // Apply filters
        let mut filtered = utils::filtering::filter_network_requests(
            &requests_arr,
            method,
            status,
            resource_type,
            domain,
            failed_only,
        );

        // Sort: failed requests first
        if failed_only || (method.is_none() && status.is_none() && resource_type.is_none() && domain.is_none()) {
            filtered.sort_by(|a, b| {
                let status_a = a.get("status")
                    .or_else(|| a.get("response").and_then(|r| r.get("status")))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let status_b = b.get("status")
                    .or_else(|| b.get("response").and_then(|r| r.get("status")))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let failed_a = status_a >= 400 || status_a == 0;
                let failed_b = status_b >= 400 || status_b == 0;
                failed_b.cmp(&failed_a)
            });
        }

        // Apply pagination
        let effective_page_size = page_size.min(200);
        let paginated = self.pagination_cursors.paginate(filtered, cursor, effective_page_size);

        // Process bodies
        let mut processed: Vec<serde_json::Value> = paginated.data;
        for req in &mut processed {
            utils::filtering::process_request_bodies(
                req,
                include_response_bodies,
                include_request_bodies,
                truncation::MAX_RESPONSE_BODY_SIZE,
            );
        }

        let message = if paginated.total == 0 {
            "No requests match the specified filters".to_string()
        } else if paginated.has_more {
            format!("Showing {} of {} requests. Use nextCursor to get more.", processed.len(), paginated.total)
        } else {
            format!("Showing all {} matching requests", paginated.total)
        };

        Ok(serde_json::json!({
            "requests": processed,
            "count": processed.len(),
            "total": paginated.total,
            "hasMore": paginated.has_more,
            "nextCursor": paginated.next_cursor,
            "filters": {
                "method": method,
                "status": status,
                "resourceType": resource_type,
                "domain": domain,
                "failedOnly": failed_only
            },
            "message": message
        }))
    }

    // ─── capture_screenshot ───────────────────────────────────────────────

    pub async fn handle_capture_screenshot(
        &self,
        tab_id: Option<u32>,
        format: &str,
        quality: f32,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::CaptureScreenshot {
            format: format.to_string(),
            quality: Some(quality),
            clip: None,
        };
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        let data = Self::extract_response_data(response)?;

        // Return text description with truncated data URL preview
        let data_str = if let Some(s) = data.as_str() {
            s.to_string()
        } else {
            serde_json::to_string(&data).unwrap_or_default()
        };

        let preview = if data_str.len() > 100 {
            format!("{}...", &data_str[..100])
        } else {
            data_str.clone()
        };

        Ok(serde_json::json!({
            "message": format!("Screenshot captured in {} format. Data URL: {}", format, preview),
            "format": format,
            "dataLength": data_str.len()
        }))
    }

    // ─── get_performance_metrics ──────────────────────────────────────────

    pub async fn handle_get_performance_metrics(
        &self,
        tab_id: Option<u32>,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetPerformanceMetrics;
        let response = if let Some(tid) = tab_id {
            self.connection_pool.send_request(tid, request).await?
        } else {
            self.connection_pool.send_request_any(request).await?
        };

        Self::extract_response_data(response)
    }

    // ─── get_accessibility_tree ───────────────────────────────────────────

    pub async fn handle_get_accessibility_tree(
        &self,
        tab_id: Option<u32>,
        timeout_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        let request = BrowserRequest::GetAccessibilityTree { max_depth: None };
        let custom_timeout = timeout_ms.map(Duration::from_millis);

        let response = self.connection_pool.send_request_with_timeout(
            tab_id,
            request,
            custom_timeout,
        ).await?;

        Self::extract_response_data(response)
    }

    // ─── get_browser_tabs ─────────────────────────────────────────────────

    pub async fn handle_get_browser_tabs(&self) -> Result<serde_json::Value> {
        let connections = self.connection_pool.get_active_connections().await;
        if connections.is_empty() {
            return Ok(serde_json::json!({
                "tabs": [],
                "message": "No active browser connections"
            }));
        }

        let request = BrowserRequest::GetBrowserTabs;
        match self.connection_pool.send_request_any(request).await {
            Ok(response) => {
                let data = Self::extract_response_data(response)?;
                Ok(data)
            }
            Err(e) => {
                Ok(serde_json::json!({
                    "tabs": [],
                    "error": e.to_string(),
                    "message": "Failed to get tabs from browser"
                }))
            }
        }
    }

    // ─── attach_debugger ──────────────────────────────────────────────────

    pub async fn handle_attach_debugger(&self, tab_id: u32) -> Result<serde_json::Value> {
        let request = BrowserRequest::AttachDebugger;
        self.connection_pool.send_request(tab_id, request).await?;
        self.data_cache.set_debugger_attached(tab_id, true).await;
        Ok(serde_json::json!({
            "message": format!("Debugger attached to tab {}", tab_id),
            "tabId": tab_id
        }))
    }

    // ─── detach_debugger ──────────────────────────────────────────────────

    pub async fn handle_detach_debugger(&self, tab_id: u32) -> Result<serde_json::Value> {
        let request = BrowserRequest::DetachDebugger;
        self.connection_pool.send_request(tab_id, request).await?;
        self.data_cache.set_debugger_attached(tab_id, false).await;
        Ok(serde_json::json!({
            "message": format!("Debugger detached from tab {}", tab_id),
            "tabId": tab_id
        }))
    }

    // ─── health ───────────────────────────────────────────────────────────

    pub async fn get_health_status(&self) -> crate::types::mcp::HealthStatus {
        let uptime = self.start_time.elapsed();
        let cache_stats = self.data_cache.get_cache_stats().await;
        let connection_stats = self.connection_pool.get_stats();
        let memory_usage = self.data_cache.get_memory_usage().await;

        crate::types::mcp::HealthStatus {
            status: "healthy".to_string(),
            timestamp: chrono::Utc::now(),
            version: "1.0.0".to_string(),
            uptime_seconds: uptime.as_secs(),
            active_connections: connection_stats
                .active_connections
                .load(std::sync::atomic::Ordering::Relaxed) as usize,
            cached_tabs: self.data_cache.get_all_tabs().await.len(),
            memory_usage_mb: memory_usage as f64 / (1024.0 * 1024.0),
            performance_stats: crate::types::mcp::PerformanceStats {
                requests_per_second: 0.0,
                average_response_time_ms: 0.0,
                cache_hit_rate: cache_stats.2,
                error_rate: 0.0,
                active_websocket_connections: connection_stats
                    .active_connections
                    .load(std::sync::atomic::Ordering::Relaxed) as usize,
            },
        }
    }
}
