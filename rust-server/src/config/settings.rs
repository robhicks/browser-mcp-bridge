use crate::types::errors::BrowserMcpError;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub server: ServerSettings,
    pub cache: CacheSettings,
    pub connections: ConnectionSettings,
    pub monitoring: MonitoringSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
    pub worker_threads: Option<usize>,
    pub max_connections: usize,
    pub request_timeout_secs: u64,
    pub cors_origins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSettings {
    pub max_size_mb: usize,
    pub cleanup_interval_secs: u64,
    pub data_ttl_secs: u64,
    pub enable_persistent_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionSettings {
    pub websocket_timeout_secs: u64,
    pub health_check_interval_secs: u64,
    pub max_connections_per_tab: usize,
    pub heartbeat_interval_secs: u64,
    pub connection_retry_attempts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringSettings {
    pub enable_metrics: bool,
    pub prometheus_port: Option<u16>,
    pub log_level: String,
    pub enable_request_logging: bool,
    pub enable_performance_monitoring: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            server: ServerSettings {
                host: "127.0.0.1".to_string(),
                port: 6009,
                worker_threads: None, // Use system default
                max_connections: 1000,
                request_timeout_secs: 30,
                cors_origins: vec!["*".to_string()],
            },
            cache: CacheSettings {
                max_size_mb: 512,
                cleanup_interval_secs: 300,
                data_ttl_secs: 3600,
                enable_persistent_cache: false,
            },
            connections: ConnectionSettings {
                websocket_timeout_secs: 300,
                health_check_interval_secs: 30,
                max_connections_per_tab: 10,
                heartbeat_interval_secs: 30,
                connection_retry_attempts: 3,
            },
            monitoring: MonitoringSettings {
                enable_metrics: true,
                prometheus_port: Some(9090),
                log_level: "info".to_string(),
                enable_request_logging: true,
                enable_performance_monitoring: true,
            },
        }
    }
}

impl ServerConfig {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> crate::types::errors::Result<Self> {
        let settings = config::Config::builder()
            .add_source(config::File::with_name(path.as_ref().to_str().unwrap()))
            .build()
            .map_err(BrowserMcpError::from)?;

        let config = settings
            .try_deserialize::<ServerConfig>()
            .map_err(BrowserMcpError::from)?;

        Ok(config)
    }

    pub fn load_from_env() -> crate::types::errors::Result<Self> {
        let mut config = Self::default();

        // Override with environment variables
        if let Ok(host) = std::env::var("MCP_SERVER_HOST") {
            config.server.host = host;
        }

        if let Ok(port) = std::env::var("MCP_SERVER_PORT") {
            config.server.port = port.parse().map_err(|_| BrowserMcpError::ConfigError {
                message: "Invalid MCP_SERVER_PORT".to_string(),
            })?;
        }

        // WebSocket now runs on the same port as MCP HTTP server

        if let Ok(log_level) = std::env::var("LOG_LEVEL") {
            config.monitoring.log_level = log_level;
        }

        if let Ok(max_connections) = std::env::var("MAX_CONNECTIONS") {
            config.server.max_connections = max_connections.parse().map_err(|_| BrowserMcpError::ConfigError {
                message: "Invalid MAX_CONNECTIONS".to_string(),
            })?;
        }

        if let Ok(cache_size) = std::env::var("CACHE_SIZE_MB") {
            config.cache.max_size_mb = cache_size.parse().map_err(|_| BrowserMcpError::ConfigError {
                message: "Invalid CACHE_SIZE_MB".to_string(),
            })?;
        }

        Ok(config)
    }

    pub fn save_to_file<P: AsRef<Path>>(&self, path: P) -> crate::types::errors::Result<()> {
        let toml_content = toml::to_string_pretty(self).map_err(|e| BrowserMcpError::ConfigError {
            message: format!("Failed to serialize config: {}", e),
        })?;

        std::fs::write(path, toml_content).map_err(|e| BrowserMcpError::ConfigError {
            message: format!("Failed to write config file: {}", e),
        })?;

        Ok(())
    }

    pub fn validate(&self) -> crate::types::errors::Result<()> {
        if self.server.port == 0 {
            return Err(BrowserMcpError::ConfigError {
                message: "Server port cannot be 0".to_string(),
            });
        }

        // MCP and WebSocket servers now run on the same port
        // MCP server handles Claude Code connections via HTTP, WebSocket server handles browser extensions via HTTP upgrade

        if self.cache.max_size_mb == 0 {
            return Err(BrowserMcpError::ConfigError {
                message: "Cache size must be greater than 0".to_string(),
            });
        }

        if self.connections.max_connections_per_tab == 0 {
            return Err(BrowserMcpError::ConfigError {
                message: "Max connections per tab must be greater than 0".to_string(),
            });
        }

        Ok(())
    }

    pub fn get_mcp_address(&self) -> String {
        format!("{}:{}", self.server.host, self.server.port)
    }

    pub fn get_websocket_address(&self) -> String {
        format!("{}:{}", self.server.host, self.server.port)
    }

    pub fn get_prometheus_address(&self) -> Option<String> {
        self.monitoring
            .prometheus_port
            .map(|port| format!("{}:{}", self.server.host, port))
    }
}