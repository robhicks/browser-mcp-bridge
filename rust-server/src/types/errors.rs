use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum BrowserMcpError {
    #[error("Connection not available for tab {tab_id}")]
    ConnectionNotAvailable { tab_id: u32 },

    #[error("Request timeout after {timeout:?}")]
    RequestTimeout { timeout: Duration },

    #[error("Connection closed unexpectedly")]
    ConnectionClosed,

    #[error("Invalid request format: {message}")]
    InvalidRequest { message: String },

    #[error("Browser extension error: {message}")]
    BrowserExtensionError { message: String },

    #[error("Tab {tab_id} not found")]
    TabNotFound { tab_id: u32 },

    #[error("JSON serialization error: {message}")]
    JsonError { message: String },

    #[error("WebSocket error: {message}")]
    WebSocketError { message: String },

    #[error("Cache error: {message}")]
    CacheError { message: String },

    #[error("Configuration error: {message}")]
    ConfigError { message: String },

    #[error("Network error: {message}")]
    NetworkError { message: String },

    #[error("Internal server error: {message}")]
    InternalError { message: String },

    #[error("Resource not found: {uri}")]
    ResourceNotFound { uri: String },

    #[error("Method not implemented: {method}")]
    MethodNotImplemented { method: String },

    #[error("Invalid parameters: {message}")]
    InvalidParameters { message: String },

    #[error("Permission denied: {message}")]
    PermissionDenied { message: String },

    #[error("Rate limit exceeded")]
    RateLimitExceeded,

    #[error("Service unavailable: {message}")]
    ServiceUnavailable { message: String },
}

impl From<serde_json::Error> for BrowserMcpError {
    fn from(err: serde_json::Error) -> Self {
        BrowserMcpError::JsonError {
            message: err.to_string(),
        }
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for BrowserMcpError {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        BrowserMcpError::WebSocketError {
            message: err.to_string(),
        }
    }
}

impl From<anyhow::Error> for BrowserMcpError {
    fn from(err: anyhow::Error) -> Self {
        BrowserMcpError::InternalError {
            message: err.to_string(),
        }
    }
}

impl From<config::ConfigError> for BrowserMcpError {
    fn from(err: config::ConfigError) -> Self {
        BrowserMcpError::ConfigError {
            message: err.to_string(),
        }
    }
}

impl From<tokio::sync::mpsc::error::SendError<axum::extract::ws::Message>> for BrowserMcpError {
    fn from(err: tokio::sync::mpsc::error::SendError<axum::extract::ws::Message>) -> Self {
        BrowserMcpError::ConnectionClosed
    }
}

// Disabled temporarily due to rmcp API compatibility issues
// impl From<BrowserMcpError> for rmcp::Error {
//     fn from(err: BrowserMcpError) -> Self {
//         use rmcp::model::ErrorData;
//         match err {
//             BrowserMcpError::InvalidParameters { message } => {
//                 rmcp::Error::ErrorData(ErrorData::invalid_request(message, None))
//             },
//             BrowserMcpError::MethodNotImplemented { method } => {
//                 rmcp::Error::ErrorData(ErrorData::method_not_found())
//             },
//             BrowserMcpError::ResourceNotFound { uri } => {
//                 rmcp::Error::ErrorData(ErrorData::resource_not_found(uri, None))
//             },
//             _ => {
//                 rmcp::Error::ErrorData(ErrorData::internal_error(err.to_string(), None))
//             },
//         }
//     }
// }

pub type Result<T> = std::result::Result<T, BrowserMcpError>;