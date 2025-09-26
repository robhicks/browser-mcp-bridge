use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    pub description: String,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResourceContent {
    pub uri: String,
    pub mime_type: Option<String>,
    pub text: Option<String>,
    pub blob: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub content: Vec<McpContent>,
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { data: String, mime_type: String },
    #[serde(rename = "resource")]
    Resource { resource: McpResourceContent },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub version: String,
    pub uptime_seconds: u64,
    pub active_connections: usize,
    pub cached_tabs: usize,
    pub memory_usage_mb: f64,
    pub performance_stats: PerformanceStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceStats {
    pub requests_per_second: f64,
    pub average_response_time_ms: f64,
    pub cache_hit_rate: f64,
    pub error_rate: f64,
    pub active_websocket_connections: usize,
}

impl McpContent {
    pub fn text(content: &str) -> Self {
        Self::Text {
            text: content.to_string(),
        }
    }

    pub fn json(value: &serde_json::Value) -> Self {
        Self::Text {
            text: serde_json::to_string_pretty(value).unwrap_or_default(),
        }
    }

    pub fn image(data: Vec<u8>, mime_type: &str) -> Self {
        use base64::Engine;
        Self::Image {
            data: base64::engine::general_purpose::STANDARD.encode(&data),
            mime_type: mime_type.to_string(),
        }
    }
}

impl McpToolResult {
    pub fn success(content: Vec<McpContent>) -> Self {
        Self {
            content,
            is_error: None,
        }
    }

    pub fn error(message: &str) -> Self {
        Self {
            content: vec![McpContent::text(message)],
            is_error: Some(true),
        }
    }

    pub fn text(text: &str) -> Self {
        Self::success(vec![McpContent::text(text)])
    }

    pub fn json(value: &serde_json::Value) -> Self {
        Self::success(vec![McpContent::json(value)])
    }
}