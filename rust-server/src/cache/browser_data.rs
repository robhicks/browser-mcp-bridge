use crate::types::{browser::*, errors::*, messages::*};
use dashmap::DashMap;
use parking_lot::RwLock;
use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone)]
pub struct BrowserDataCache {
    // Tab-indexed data for O(1) lookups
    tab_data: Arc<DashMap<u32, Arc<TabData>>>,

    // Connection to tab mapping
    connection_tabs: Arc<DashMap<Uuid, u32>>,
    tab_connections: Arc<DashMap<u32, HashSet<Uuid>>>,

    // Event broadcasting for real-time updates
    update_sender: broadcast::Sender<DataUpdateEvent>,

    // Memory management
    max_cache_size: usize,
    cleanup_interval: Duration,
    data_ttl: Duration,

    // Performance monitoring
    cache_hits: Arc<std::sync::atomic::AtomicU64>,
    cache_misses: Arc<std::sync::atomic::AtomicU64>,
}

impl BrowserDataCache {
    pub fn new(max_cache_size: usize, data_ttl: Duration) -> Self {
        let (update_sender, _) = broadcast::channel(1000);

        Self {
            tab_data: Arc::new(DashMap::new()),
            connection_tabs: Arc::new(DashMap::new()),
            tab_connections: Arc::new(DashMap::new()),
            update_sender,
            max_cache_size,
            cleanup_interval: Duration::from_secs(300), // 5 minutes
            data_ttl,
            cache_hits: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            cache_misses: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    // Zero-copy data access
    pub async fn get_tab_data(&self, tab_id: u32) -> Option<Arc<TabData>> {
        if let Some(data) = self.tab_data.get(&tab_id) {
            self.cache_hits
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Some(data.value().clone())
        } else {
            self.cache_misses
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            None
        }
    }

    pub async fn get_all_tabs(&self) -> Vec<Arc<TabData>> {
        self.tab_data
            .iter()
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub async fn get_page_content(&self, tab_id: u32) -> Option<Arc<PageContent>> {
        self.get_tab_data(tab_id)
            .await?
            .page_content
            .clone()
    }

    pub async fn get_dom_snapshot(&self, tab_id: u32) -> Option<Arc<DomSnapshot>> {
        self.get_tab_data(tab_id)
            .await?
            .dom_snapshot
            .clone()
    }

    pub async fn get_console_logs(&self, tab_id: u32) -> Option<Vec<ConsoleMessage>> {
        let tab_data = self.get_tab_data(tab_id).await?;
        let console_logs = tab_data.console_logs.as_ref()?;
        let logs = console_logs.read();
        Some(logs.iter().cloned().collect())
    }

    pub async fn get_network_requests(&self, tab_id: u32) -> Option<Vec<NetworkRequest>> {
        let tab_data = self.get_tab_data(tab_id).await?;
        let network_data = tab_data.network_data.as_ref()?;
        let requests = network_data.read();
        Some(requests.iter().cloned().collect())
    }

    // Atomic data updates
    pub async fn update_page_content(&self, tab_id: u32, content: PageContent) {
        let new_content = Arc::new(content);

        // Update or create tab data
        let updated_data = if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.page_content = Some(new_content);
            data.last_updated = SystemTime::now();
            Arc::new(data)
        } else {
            Arc::new(TabData {
                tab_id,
                page_content: Some(new_content),
                dom_snapshot: None,
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: None,
                accessibility_tree: None,
                screenshot_data: None,
                debugger_attached: false,
                last_updated: SystemTime::now(),
            })
        };

        self.tab_data.insert(tab_id, updated_data);

        // Broadcast update event
        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::PageContentUpdated,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn update_dom_snapshot(&self, tab_id: u32, snapshot: DomSnapshot) {
        let new_snapshot = Arc::new(snapshot);

        let updated_data = if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.dom_snapshot = Some(new_snapshot);
            data.last_updated = SystemTime::now();
            Arc::new(data)
        } else {
            Arc::new(TabData {
                tab_id,
                page_content: None,
                dom_snapshot: Some(new_snapshot),
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: None,
                accessibility_tree: None,
                screenshot_data: None,
                debugger_attached: false,
                last_updated: SystemTime::now(),
            })
        };

        self.tab_data.insert(tab_id, updated_data);

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::DomSnapshotUpdated,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn add_console_message(&self, tab_id: u32, message: ConsoleMessage) {
        self.ensure_tab_data_exists(tab_id).await;

        if let Some(tab_data) = self.tab_data.get(&tab_id) {
            if let Some(console_logs) = &tab_data.console_logs {
                let mut logs = console_logs.write();
                logs.push_back(message);

                // Limit console log size to prevent memory growth
                while logs.len() > 1000 {
                    logs.pop_front();
                }
            }
        }

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::ConsoleMessageAdded,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn add_network_request(&self, tab_id: u32, request: NetworkRequest) {
        self.ensure_tab_data_exists(tab_id).await;

        if let Some(tab_data) = self.tab_data.get(&tab_id) {
            if let Some(network_data) = &tab_data.network_data {
                let mut requests = network_data.write();
                requests.push_back(request);

                // Limit network request history to prevent memory growth
                while requests.len() > 500 {
                    requests.pop_front();
                }
            }
        }

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::NetworkRequestAdded,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn update_performance_metrics(&self, tab_id: u32, metrics: PerformanceMetrics) {
        let new_metrics = Arc::new(metrics);

        let updated_data = if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.performance_metrics = Some(new_metrics);
            data.last_updated = SystemTime::now();
            Arc::new(data)
        } else {
            Arc::new(TabData {
                tab_id,
                page_content: None,
                dom_snapshot: None,
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: Some(new_metrics),
                accessibility_tree: None,
                screenshot_data: None,
                debugger_attached: false,
                last_updated: SystemTime::now(),
            })
        };

        self.tab_data.insert(tab_id, updated_data);

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::PerformanceMetricsUpdated,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn update_accessibility_tree(&self, tab_id: u32, tree: AccessibilityTree) {
        let new_tree = Arc::new(tree);

        let updated_data = if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.accessibility_tree = Some(new_tree);
            data.last_updated = SystemTime::now();
            Arc::new(data)
        } else {
            Arc::new(TabData {
                tab_id,
                page_content: None,
                dom_snapshot: None,
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: None,
                accessibility_tree: Some(new_tree),
                screenshot_data: None,
                debugger_attached: false,
                last_updated: SystemTime::now(),
            })
        };

        self.tab_data.insert(tab_id, updated_data);

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::AccessibilityTreeUpdated,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn update_screenshot(&self, tab_id: u32, screenshot: ScreenshotData) {
        let new_screenshot = Arc::new(screenshot);

        let updated_data = if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.screenshot_data = Some(new_screenshot);
            data.last_updated = SystemTime::now();
            Arc::new(data)
        } else {
            Arc::new(TabData {
                tab_id,
                page_content: None,
                dom_snapshot: None,
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: None,
                accessibility_tree: None,
                screenshot_data: Some(new_screenshot),
                debugger_attached: false,
                last_updated: SystemTime::now(),
            })
        };

        self.tab_data.insert(tab_id, updated_data);

        let event = DataUpdateEvent {
            tab_id,
            update_type: DataUpdateType::ScreenshotCaptured,
            timestamp: chrono::Utc::now(),
        };
        let _ = self.update_sender.send(event);
    }

    pub async fn set_debugger_attached(&self, tab_id: u32, attached: bool) {
        if let Some(mut existing) = self.tab_data.get_mut(&tab_id) {
            let mut data = (**existing).clone();
            data.debugger_attached = attached;
            data.last_updated = SystemTime::now();
            let updated_data = Arc::new(data);
            self.tab_data.insert(tab_id, updated_data);
        }
    }

    // Connection management
    pub async fn register_connection(&self, connection_id: Uuid, tab_id: u32) {
        self.connection_tabs.insert(connection_id, tab_id);

        let mut connections = self.tab_connections.entry(tab_id).or_insert_with(HashSet::new);
        connections.insert(connection_id);
    }

    pub async fn unregister_connection(&self, connection_id: Uuid) {
        if let Some((_, tab_id)) = self.connection_tabs.remove(&connection_id) {
            if let Some(mut connections) = self.tab_connections.get_mut(&tab_id) {
                connections.remove(&connection_id);
                if connections.is_empty() {
                    self.tab_connections.remove(&tab_id);
                }
            }
        }
    }

    pub async fn get_connections_for_tab(&self, tab_id: u32) -> HashSet<Uuid> {
        self.tab_connections
            .get(&tab_id)
            .map(|connections| connections.clone())
            .unwrap_or_default()
    }

    // Event subscription
    pub fn subscribe_to_updates(&self) -> broadcast::Receiver<DataUpdateEvent> {
        self.update_sender.subscribe()
    }

    // Memory management with LRU eviction
    pub async fn cleanup_stale_data(&self) {
        let now = SystemTime::now();
        let stale_threshold = self.data_ttl;

        let stale_tabs: Vec<u32> = self
            .tab_data
            .iter()
            .filter_map(|entry| {
                let (tab_id, data) = entry.pair();
                if now.duration_since(data.last_updated).unwrap_or_default() > stale_threshold {
                    Some(*tab_id)
                } else {
                    None
                }
            })
            .collect();

        for tab_id in stale_tabs {
            self.remove_tab_data(tab_id).await;
        }

        // If we're still over the size limit, remove oldest entries
        if self.tab_data.len() > self.max_cache_size {
            let mut entries: Vec<_> = self
                .tab_data
                .iter()
                .map(|entry| (*entry.key(), entry.value().last_updated))
                .collect();

            entries.sort_by_key(|(_, last_updated)| *last_updated);

            let to_remove = entries.len() - self.max_cache_size;
            for (tab_id, _) in entries.into_iter().take(to_remove) {
                self.remove_tab_data(tab_id).await;
            }
        }
    }

    pub async fn remove_tab_data(&self, tab_id: u32) {
        self.tab_data.remove(&tab_id);
        self.tab_connections.remove(&tab_id);

        // Remove connection mappings for this tab
        let connections_to_remove: Vec<Uuid> = self
            .connection_tabs
            .iter()
            .filter_map(|entry| {
                if *entry.value() == tab_id {
                    Some(*entry.key())
                } else {
                    None
                }
            })
            .collect();

        for connection_id in connections_to_remove {
            self.connection_tabs.remove(&connection_id);
        }
    }

    pub async fn get_cache_stats(&self) -> (u64, u64, f64) {
        let hits = self.cache_hits.load(std::sync::atomic::Ordering::Relaxed);
        let misses = self.cache_misses.load(std::sync::atomic::Ordering::Relaxed);
        let total = hits + misses;
        let hit_rate = if total > 0 {
            hits as f64 / total as f64
        } else {
            0.0
        };
        (hits, misses, hit_rate)
    }

    pub async fn get_memory_usage(&self) -> usize {
        // Rough estimation of memory usage
        let tab_count = self.tab_data.len();
        let connection_count = self.connection_tabs.len();

        // Estimate: each tab takes ~100KB on average, each connection ~1KB
        (tab_count * 100 * 1024) + (connection_count * 1024)
    }

    async fn ensure_tab_data_exists(&self, tab_id: u32) {
        if !self.tab_data.contains_key(&tab_id) {
            let tab_data = Arc::new(TabData {
                tab_id,
                page_content: None,
                dom_snapshot: None,
                console_logs: Some(Arc::new(RwLock::new(VecDeque::new()))),
                network_data: Some(Arc::new(RwLock::new(VecDeque::new()))),
                performance_metrics: None,
                accessibility_tree: None,
                screenshot_data: None,
                debugger_attached: false,
                last_updated: SystemTime::now(),
            });

            self.tab_data.insert(tab_id, tab_data);
        }
    }
}