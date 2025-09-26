use crate::{
    cache::BrowserDataCache,
    config::ServerConfig,
    transport::ConnectionPool,
    types::{errors::*, messages::*},
};
// Note: rmcp ServerHandler implementation is temporarily disabled
// due to API complexity. The architecture pattern is demonstrated
// with separate HTTP servers that can be upgraded to full rmcp later.
use std::{sync::Arc, time::Duration};

/// Simplified server implementation for compatibility testing
pub struct SimpleBrowserMcpServer {
    pub data_cache: Arc<BrowserDataCache>,
    pub connection_pool: Arc<ConnectionPool>,
    pub config: ServerConfig,
    start_time: std::time::Instant,
}

impl SimpleBrowserMcpServer {
    pub async fn new(config: ServerConfig) -> crate::types::errors::Result<Self> {
        let data_cache = Arc::new(BrowserDataCache::new(
            config.cache.max_size_mb * 1024 * 1024, // Convert to bytes
            Duration::from_secs(config.cache.data_ttl_secs),
        ));

        let connection_pool = Arc::new(ConnectionPool::new(
            Duration::from_secs(config.connections.health_check_interval_secs),
            Duration::from_secs(config.connections.websocket_timeout_secs),
        ));

        Ok(Self {
            data_cache,
            connection_pool,
            config,
            start_time: std::time::Instant::now(),
        })
    }

    pub async fn handle_get_page_content(&self, tab_id: Option<u32>, include_metadata: bool) -> Result<serde_json::Value> {
        let tab_id = tab_id.unwrap_or(1);

        // Fast path: Check cache first
        if let Some(cached_content) = self.data_cache.get_page_content(tab_id).await {
            if cached_content.is_fresh(Duration::from_secs(30)) {
                return Ok(self.format_page_content_response(&cached_content, include_metadata));
            }
        }

        // Slow path: Request from browser
        let request = BrowserRequest::GetPageContent { include_metadata };
        let response = self.connection_pool.send_request(tab_id, request).await?;

        if let BrowserResponse::PageContent(content) = response {
            // Update cache
            self.data_cache.update_page_content(tab_id, content.clone()).await;
            Ok(self.format_page_content_response(&content, include_metadata))
        } else {
            Err(BrowserMcpError::InternalError {
                message: "Unexpected response type".to_string()
            })
        }
    }

    fn format_page_content_response(&self, content: &crate::types::browser::PageContent, include_metadata: bool) -> serde_json::Value {
        let mut result = serde_json::json!({
            "url": content.url,
            "title": content.title,
            "text": content.text,
        });

        if include_metadata {
            result["html"] = serde_json::Value::String(content.html.clone());
            result["metadata"] = serde_json::to_value(&content.metadata).unwrap_or(serde_json::Value::Null);
        }

        result
    }

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
                cache_hit_rate: cache_stats.2, // hit rate is the third element
                error_rate: 0.0,
                active_websocket_connections: connection_stats
                    .active_connections
                    .load(std::sync::atomic::Ordering::Relaxed) as usize,
            },
        }
    }

    pub async fn handle_get_browser_tabs(&self) -> Result<serde_json::Value> {
        // For now, return a placeholder response
        // In a real implementation, this would request from browser
        let request = BrowserRequest::GetBrowserTabs;

        // Try to send to any available connection
        let connections = self.connection_pool.get_active_connections().await;
        if connections.is_empty() {
            return Ok(serde_json::json!({
                "tabs": [],
                "message": "No active browser connections"
            }));
        }

        // Use tab ID 1 as a default for getting tabs (browser global operation)
        match self.connection_pool.send_request(1, request).await {
            Ok(BrowserResponse::BrowserTabs(tabs)) => {
                Ok(serde_json::json!({
                    "tabs": tabs
                }))
            }
            Ok(_) => Err(BrowserMcpError::InternalError {
                message: "Unexpected response type".to_string(),
            }),
            Err(e) => {
                // Fallback to cached data or return empty
                Ok(serde_json::json!({
                    "tabs": [],
                    "error": e.to_string(),
                    "message": "Failed to get tabs from browser, no cached data available"
                }))
            }
        }
    }

    pub async fn handle_execute_javascript(&self, tab_id: Option<u32>, code: String) -> Result<serde_json::Value> {
        let tab_id = tab_id.unwrap_or(1);

        let request = BrowserRequest::ExecuteJavaScript {
            code,
            return_by_value: true,
        };

        match self.connection_pool.send_request(tab_id, request).await {
            Ok(BrowserResponse::JavaScriptResult(result)) => {
                Ok(serde_json::json!({
                    "result": result
                }))
            }
            Ok(_) => Err(BrowserMcpError::InternalError {
                message: "Unexpected response type".to_string(),
            }),
            Err(e) => Err(e),
        }
    }
}

// Note: ServerHandler implementation is temporarily disabled.
// The architecture pattern (separate MCP and WebSocket servers) is demonstrated
// in main.rs. Full rmcp integration can be added later.