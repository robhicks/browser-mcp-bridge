use crate::types::mcp::{HealthStatus, PerformanceStats};
use axum::{http::StatusCode, response::Json, routing::get, Router};
use metrics_exporter_prometheus::PrometheusHandle;
use std::sync::Arc;

pub struct HealthMonitor {
    start_time: std::time::Instant,
    prometheus_handle: Option<Arc<PrometheusHandle>>,
}

impl HealthMonitor {
    pub fn new() -> Self {
        Self {
            start_time: std::time::Instant::now(),
            prometheus_handle: None,
        }
    }

    pub fn with_prometheus(mut self, handle: PrometheusHandle) -> Self {
        self.prometheus_handle = Some(Arc::new(handle));
        self
    }

    pub fn uptime(&self) -> std::time::Duration {
        self.start_time.elapsed()
    }

    pub fn get_prometheus_metrics(&self) -> Option<String> {
        self.prometheus_handle
            .as_ref()
            .map(|handle| handle.render())
    }
}

impl Default for HealthMonitor {
    fn default() -> Self {
        Self::new()
    }
}

pub fn create_health_router() -> Router {
    Router::new()
        .route("/health", get(health_check))
        .route("/health/live", get(liveness_check))
        .route("/health/ready", get(readiness_check))
        .route("/metrics", get(metrics_endpoint))
}

async fn health_check() -> Json<HealthStatus> {
    Json(HealthStatus {
        status: "healthy".to_string(),
        timestamp: chrono::Utc::now(),
        version: "1.0.0".to_string(),
        uptime_seconds: 0, // This would be filled by the actual server
        active_connections: 0,
        cached_tabs: 0,
        memory_usage_mb: 0.0,
        performance_stats: PerformanceStats {
            requests_per_second: 0.0,
            average_response_time_ms: 0.0,
            cache_hit_rate: 0.0,
            error_rate: 0.0,
            active_websocket_connections: 0,
        },
    })
}

async fn liveness_check() -> StatusCode {
    // Basic liveness check - if we can respond, we're alive
    StatusCode::OK
}

async fn readiness_check() -> Result<StatusCode, StatusCode> {
    // More comprehensive readiness check
    // Check if all critical services are available

    // For now, just return OK
    // In a real implementation, this would check:
    // - Database connectivity
    // - External service dependencies
    // - Resource availability
    Ok(StatusCode::OK)
}

async fn metrics_endpoint() -> Result<String, StatusCode> {
    // Return Prometheus metrics if available
    // For now, return a basic metric
    Ok("# HELP browser_mcp_server_info Server information\n# TYPE browser_mcp_server_info gauge\nbrowser_mcp_server_info{version=\"1.0.0\"} 1\n".to_string())
}

pub struct SystemMetrics {
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub disk_usage: f64,
    pub network_connections: usize,
}

impl SystemMetrics {
    pub fn collect() -> Self {
        // In a real implementation, this would collect actual system metrics
        Self {
            cpu_usage: 0.0,
            memory_usage: 0.0,
            disk_usage: 0.0,
            network_connections: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_test::TestServer;

    #[tokio::test]
    async fn test_health_endpoints() {
        let app = create_health_router();
        let server = TestServer::new(app).unwrap();

        // Test health check
        let response = server.get("/health").await;
        assert_eq!(response.status_code(), 200);

        // Test liveness check
        let response = server.get("/health/live").await;
        assert_eq!(response.status_code(), 200);

        // Test readiness check
        let response = server.get("/health/ready").await;
        assert_eq!(response.status_code(), 200);

        // Test metrics endpoint
        let response = server.get("/metrics").await;
        assert_eq!(response.status_code(), 200);
        let metrics = response.text();
        assert!(metrics.contains("browser_mcp_server_info"));
    }

    #[test]
    fn test_health_monitor() {
        let monitor = HealthMonitor::new();
        assert!(monitor.uptime().as_millis() >= 0);
    }

    #[test]
    fn test_system_metrics() {
        let metrics = SystemMetrics::collect();
        assert!(metrics.cpu_usage >= 0.0);
        assert!(metrics.memory_usage >= 0.0);
        assert!(metrics.disk_usage >= 0.0);
        assert!(metrics.network_connections >= 0);
    }
}