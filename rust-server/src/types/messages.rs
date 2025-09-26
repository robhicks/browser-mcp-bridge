use crate::types::browser::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum BrowserMessage {
    #[serde(rename = "request")]
    Request {
        request_id: Uuid,
        action: BrowserRequest,
        tab_id: Option<u32>,
    },
    #[serde(rename = "response")]
    Response {
        request_id: Uuid,
        result: Result<BrowserResponse, String>,
    },
    #[serde(rename = "notification")]
    Notification { event: BrowserEvent },
    #[serde(rename = "heartbeat")]
    Heartbeat { timestamp: chrono::DateTime<chrono::Utc> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", content = "params")]
pub enum BrowserRequest {
    #[serde(rename = "get_page_content")]
    GetPageContent { include_metadata: bool },

    #[serde(rename = "get_dom_snapshot")]
    GetDomSnapshot {
        max_depth: usize,
        include_styles: bool,
    },

    #[serde(rename = "execute_javascript")]
    ExecuteJavaScript {
        code: String,
        return_by_value: bool,
    },

    #[serde(rename = "get_console_messages")]
    GetConsoleMessages {
        level_filter: Option<String>,
        limit: Option<usize>,
    },

    #[serde(rename = "get_network_requests")]
    GetNetworkRequests {
        include_bodies: bool,
        limit: Option<usize>,
    },

    #[serde(rename = "capture_screenshot")]
    CaptureScreenshot {
        format: String,
        quality: Option<f32>,
        clip: Option<BoundingBox>,
    },

    #[serde(rename = "get_performance_metrics")]
    GetPerformanceMetrics,

    #[serde(rename = "get_accessibility_tree")]
    GetAccessibilityTree { max_depth: Option<usize> },

    #[serde(rename = "get_browser_tabs")]
    GetBrowserTabs,

    #[serde(rename = "attach_debugger")]
    AttachDebugger,

    #[serde(rename = "detach_debugger")]
    DetachDebugger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum BrowserResponse {
    #[serde(rename = "page_content")]
    PageContent(PageContent),

    #[serde(rename = "dom_snapshot")]
    DomSnapshot(DomSnapshot),

    #[serde(rename = "javascript_result")]
    JavaScriptResult(JavaScriptExecutionResult),

    #[serde(rename = "console_messages")]
    ConsoleMessages(Vec<ConsoleMessage>),

    #[serde(rename = "network_requests")]
    NetworkRequests(Vec<NetworkRequest>),

    #[serde(rename = "screenshot")]
    Screenshot(ScreenshotData),

    #[serde(rename = "performance_metrics")]
    PerformanceMetrics(PerformanceMetrics),

    #[serde(rename = "accessibility_tree")]
    AccessibilityTree(AccessibilityTree),

    #[serde(rename = "browser_tabs")]
    BrowserTabs(Vec<BrowserTab>),

    #[serde(rename = "debugger_attached")]
    DebuggerAttached { success: bool },

    #[serde(rename = "debugger_detached")]
    DebuggerDetached { success: bool },

    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum BrowserEvent {
    #[serde(rename = "tab_created")]
    TabCreated { tab: BrowserTab },

    #[serde(rename = "tab_updated")]
    TabUpdated { tab: BrowserTab },

    #[serde(rename = "tab_removed")]
    TabRemoved { tab_id: u32 },

    #[serde(rename = "page_loaded")]
    PageLoaded { tab_id: u32, url: String },

    #[serde(rename = "console_message")]
    ConsoleMessage {
        tab_id: u32,
        message: ConsoleMessage,
    },

    #[serde(rename = "network_request")]
    NetworkRequest {
        tab_id: u32,
        request: NetworkRequest,
    },

    #[serde(rename = "connection_established")]
    ConnectionEstablished { tab_id: u32 },

    #[serde(rename = "connection_lost")]
    ConnectionLost { tab_id: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataUpdateEvent {
    pub tab_id: u32,
    pub update_type: DataUpdateType,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DataUpdateType {
    PageContentUpdated,
    DomSnapshotUpdated,
    ConsoleMessageAdded,
    NetworkRequestAdded,
    PerformanceMetricsUpdated,
    AccessibilityTreeUpdated,
    ScreenshotCaptured,
}