use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct TabData {
    pub tab_id: u32,
    pub page_content: Option<Arc<PageContent>>,
    pub dom_snapshot: Option<Arc<DomSnapshot>>,
    pub console_logs: Option<Arc<parking_lot::RwLock<VecDeque<ConsoleMessage>>>>,
    pub network_data: Option<Arc<parking_lot::RwLock<VecDeque<NetworkRequest>>>>,
    pub performance_metrics: Option<Arc<PerformanceMetrics>>,
    pub accessibility_tree: Option<Arc<AccessibilityTree>>,
    pub screenshot_data: Option<Arc<ScreenshotData>>,
    pub debugger_attached: bool,
    pub last_updated: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageContent {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub metadata: HashMap<String, String>,
    pub last_updated: SystemTime,
}

impl PageContent {
    pub fn is_fresh(&self, max_age: std::time::Duration) -> bool {
        SystemTime::now()
            .duration_since(self.last_updated)
            .map_or(false, |age| age <= max_age)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomSnapshot {
    pub root: DomNode,
    pub node_count: usize,
    pub max_depth: usize,
    pub include_styles: bool,
    pub timestamp: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomNode {
    pub node_type: String,
    pub tag_name: Option<String>,
    pub text_content: Option<String>,
    pub attributes: HashMap<String, String>,
    pub computed_styles: Option<HashMap<String, String>>,
    pub children: Vec<DomNode>,
    pub xpath: Option<String>,
    pub selector: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleMessage {
    pub level: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub source: Option<String>,
    pub line_number: Option<u32>,
    pub column_number: Option<u32>,
    pub stack_trace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub status_code: Option<u16>,
    pub status_text: Option<String>,
    pub request_headers: HashMap<String, String>,
    pub response_headers: Option<HashMap<String, String>>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub duration_ms: Option<f64>,
    pub failed: bool,
    pub from_cache: bool,
    pub resource_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceMetrics {
    pub navigation_timing: NavigationTiming,
    pub resource_timing: Vec<ResourceTiming>,
    pub core_web_vitals: CoreWebVitals,
    pub memory_usage: MemoryUsage,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationTiming {
    pub dns_lookup: f64,
    pub tcp_connect: f64,
    pub ssl_handshake: f64,
    pub request: f64,
    pub response: f64,
    pub dom_processing: f64,
    pub load_complete: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceTiming {
    pub name: String,
    pub entry_type: String,
    pub start_time: f64,
    pub duration: f64,
    pub transfer_size: u64,
    pub encoded_body_size: u64,
    pub decoded_body_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreWebVitals {
    pub largest_contentful_paint: Option<f64>,
    pub first_input_delay: Option<f64>,
    pub cumulative_layout_shift: Option<f64>,
    pub first_contentful_paint: Option<f64>,
    pub time_to_interactive: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryUsage {
    pub used_js_heap_size: u64,
    pub total_js_heap_size: u64,
    pub js_heap_size_limit: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessibilityTree {
    pub root: AccessibilityNode,
    pub node_count: usize,
    pub timestamp: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessibilityNode {
    pub role: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
    pub properties: HashMap<String, serde_json::Value>,
    pub children: Vec<AccessibilityNode>,
    pub bounds: Option<BoundingBox>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotData {
    pub data: Vec<u8>,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub timestamp: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTab {
    pub id: u32,
    pub title: String,
    pub url: String,
    pub active: bool,
    pub loading: bool,
    pub favicon_url: Option<String>,
    pub window_id: Option<u32>,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaScriptExecutionResult {
    pub result: serde_json::Value,
    pub error: Option<String>,
    pub console_messages: Vec<ConsoleMessage>,
    pub execution_time_ms: f64,
}

impl Default for TabData {
    fn default() -> Self {
        Self {
            tab_id: 0,
            page_content: None,
            dom_snapshot: None,
            console_logs: None,
            network_data: None,
            performance_metrics: None,
            accessibility_tree: None,
            screenshot_data: None,
            debugger_attached: false,
            last_updated: SystemTime::now(),
        }
    }
}