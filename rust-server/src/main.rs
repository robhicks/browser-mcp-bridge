use browser_mcp_rust_server::{SimpleBrowserMcpServer, ServerConfig, start_combined_server};
use clap::Parser;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Parser)]
#[command(name = "browser-mcp-rust")]
#[command(about = "High-performance Rust MCP server for browser extension bridge")]
struct Cli {
    /// Configuration file path
    #[arg(short, long, default_value = "config.toml")]
    config: String,

    /// Server port (handles both MCP and WebSocket)
    #[arg(short, long)]
    port: Option<u16>,

    /// Log level
    #[arg(short, long, default_value = "info")]
    log_level: String,

    /// Host address to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Enable metrics server
    #[arg(long)]
    enable_metrics: bool,

    /// Metrics server port
    #[arg(long, default_value = "9090")]
    metrics_port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("browser_mcp_rust_server={}", cli.log_level).into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    let mut config = if std::path::Path::new(&cli.config).exists() {
        ServerConfig::load_from_file(&cli.config)?
    } else {
        tracing::warn!("Config file '{}' not found, using defaults and environment variables", cli.config);
        ServerConfig::load_from_env()?
    };

    // Override with CLI arguments
    if let Some(port) = cli.port {
        config.server.port = port;
    }
    if !cli.host.is_empty() {
        config.server.host = cli.host;
    }
    if cli.enable_metrics {
        config.monitoring.enable_metrics = true;
        config.monitoring.prometheus_port = Some(cli.metrics_port);
    }

    // Validate configuration
    config.validate()?;

    tracing::info!("Starting browser MCP server with configuration:");
    tracing::info!("  Combined Server: http://{}:{}", config.server.host, config.server.port);
    tracing::info!("  MCP endpoint: http://{}:{}/mcp", config.server.host, config.server.port);
    tracing::info!("  WebSocket endpoint: ws://{}:{}/ws", config.server.host, config.server.port);
    tracing::info!("  Cache size: {} MB", config.cache.max_size_mb);
    tracing::info!("  Max connections: {}", config.server.max_connections);

    // Create MCP server handler
    let mcp_handler = Arc::new(SimpleBrowserMcpServer::new(config.clone()).await?);

    // Start combined HTTP/WebSocket server on single port
    let combined_server_handle = tokio::spawn({
        let mcp_handler = mcp_handler.clone();
        let host = config.server.host.clone();
        let port = config.server.port;
        async move {
            if let Err(e) = start_combined_server(
                mcp_handler,
                &host,
                port,
            ).await {
                tracing::error!("Combined server error: {}", e);
            }
        }
    });

    // Start background cleanup task
    let cleanup_handle = tokio::spawn({
        let mcp_handler = mcp_handler.clone();
        let cleanup_interval = std::time::Duration::from_secs(config.cache.cleanup_interval_secs);
        async move {
            background_cleanup_task(mcp_handler, cleanup_interval).await;
        }
    });

    // Start metrics server if enabled
    let metrics_handle = if config.monitoring.enable_metrics {
        if let Some(prometheus_port) = config.monitoring.prometheus_port {
            Some(tokio::spawn({
                let host = config.server.host.clone();
                async move {
                    if let Err(e) = start_metrics_server(&host, prometheus_port).await {
                        tracing::error!("Metrics server error: {}", e);
                    }
                }
            }))
        } else {
            None
        }
    } else {
        None
    };

    tracing::info!("🚀 Browser MCP Rust server starting");
    tracing::info!("📊 MCP endpoint: http://{}:{}/mcp", config.server.host, config.server.port);
    tracing::info!("🔌 WebSocket endpoint: ws://{}:{}/ws", config.server.host, config.server.port);
    tracing::info!("❤️  Health check: http://{}:{}/health", config.server.host, config.server.port);

    if let Some(prometheus_port) = config.monitoring.prometheus_port {
        if config.monitoring.enable_metrics {
            tracing::info!("📈 Metrics endpoint: http://{}:{}/metrics", config.server.host, prometheus_port);
        }
    }

    // Setup graceful shutdown
    let shutdown_signal = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install CTRL+C signal handler");
        tracing::info!("Received shutdown signal, gracefully shutting down...");
    };

    // Run servers concurrently using tokio::select!
    tokio::select! {
        result = combined_server_handle => {
            if let Err(e) = result {
                tracing::error!("Combined server task error: {:?}", e);
            }
        }
        result = cleanup_handle => {
            if let Err(e) = result {
                tracing::error!("Cleanup task error: {:?}", e);
            }
        }
        result = async {
            if let Some(handle) = metrics_handle {
                handle.await
            } else {
                std::future::pending().await
            }
        } => {
            if let Err(e) = result {
                tracing::error!("Metrics server task error: {:?}", e);
            }
        }
        _ = shutdown_signal => {
            tracing::info!("Shutdown signal received");
        }
    }

    tracing::info!("Browser MCP Rust server shutdown complete");
    Ok(())
}

// The combined server function is now in src/server/combined.rs
// and handles both MCP JSON-RPC and WebSocket upgrades on the same port


async fn background_cleanup_task(
    server: Arc<SimpleBrowserMcpServer>,
    cleanup_interval: std::time::Duration,
) {
    let mut interval = tokio::time::interval(cleanup_interval);

    loop {
        interval.tick().await;

        // Cleanup stale data
        server.data_cache.cleanup_stale_data().await;

        // Cleanup stale connections
        server.connection_pool.cleanup_stale_connections().await;

        tracing::debug!("Background cleanup completed");
    }
}

async fn start_metrics_server(host: &str, port: u16) -> anyhow::Result<()> {
    use axum::{routing::get, Router};
    use metrics_exporter_prometheus::PrometheusBuilder;
    use tokio::net::TcpListener;

    // Set up Prometheus metrics exporter
    let builder = PrometheusBuilder::new();
    let handle = builder
        .install_recorder()
        .map_err(|e| anyhow::anyhow!("Failed to install Prometheus recorder: {}", e))?;

    let metrics_app = Router::new().route(
        "/metrics",
        get(|| async move { handle.render() }),
    );

    let addr = format!("{}:{}", host, port);
    let listener = TcpListener::bind(&addr).await?;

    tracing::info!("Metrics server listening on http://{}/metrics", addr);

    axum::serve(listener, metrics_app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use std::io::Write;

    #[tokio::test]
    async fn test_config_loading() {
        // Test default config
        let config = ServerConfig::load_from_env().unwrap();
        assert_eq!(config.server.port, 6009);

        // Test config file loading with .toml extension
        let mut temp_file = NamedTempFile::with_suffix(".toml").unwrap();
        writeln!(
            temp_file,
            r#"
[server]
host = "0.0.0.0"
port = 8080
worker_threads = 4
max_connections = 500
request_timeout_secs = 60
cors_origins = ["*"]

[cache]
max_size_mb = 256
cleanup_interval_secs = 300
data_ttl_secs = 3600
enable_persistent_cache = false

[connections]
websocket_timeout_secs = 300
health_check_interval_secs = 30
max_connections_per_tab = 10
heartbeat_interval_secs = 30
connection_retry_attempts = 3

[monitoring]
enable_metrics = true
prometheus_port = 9090
log_level = "info"
enable_request_logging = true
enable_performance_monitoring = true
"#
        ).unwrap();

        let config = ServerConfig::load_from_file(temp_file.path()).unwrap();
        assert_eq!(config.server.host, "0.0.0.0");
        assert_eq!(config.server.port, 8080);
        assert_eq!(config.cache.max_size_mb, 256);
    }

    #[test]
    fn test_cli_parsing() {
        let args = vec!["browser-mcp-rust", "--port", "8080", "--log-level", "debug"];
        let cli = Cli::try_parse_from(args).unwrap();
        assert_eq!(cli.port, Some(8080));
        assert_eq!(cli.log_level, "debug");
    }
}