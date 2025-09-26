use crate::types::{errors::*, messages::*};
use std::collections::HashMap;
use uuid::Uuid;

/// Browser communication abstraction layer
pub struct BrowserCommunicator {
    active_tabs: parking_lot::RwLock<HashMap<u32, TabInfo>>,
    connection_mapping: parking_lot::RwLock<HashMap<Uuid, u32>>,
}

#[derive(Debug, Clone)]
pub struct TabInfo {
    pub tab_id: u32,
    pub title: Option<String>,
    pub url: Option<String>,
    pub active: bool,
    pub connection_count: usize,
    pub last_seen: std::time::SystemTime,
}

impl BrowserCommunicator {
    pub fn new() -> Self {
        Self {
            active_tabs: parking_lot::RwLock::new(HashMap::new()),
            connection_mapping: parking_lot::RwLock::new(HashMap::new()),
        }
    }

    pub fn register_tab(&self, tab_id: u32, title: Option<String>, url: Option<String>) {
        let mut tabs = self.active_tabs.write();
        let tab_info = TabInfo {
            tab_id,
            title,
            url,
            active: false,
            connection_count: 0,
            last_seen: std::time::SystemTime::now(),
        };
        tabs.insert(tab_id, tab_info);
    }

    pub fn associate_connection(&self, connection_id: Uuid, tab_id: u32) -> Result<()> {
        let mut tabs = self.active_tabs.write();
        let mut connections = self.connection_mapping.write();

        if let Some(tab_info) = tabs.get_mut(&tab_id) {
            tab_info.connection_count += 1;
            tab_info.last_seen = std::time::SystemTime::now();
            connections.insert(connection_id, tab_id);
            Ok(())
        } else {
            Err(BrowserMcpError::TabNotFound { tab_id })
        }
    }

    pub fn disassociate_connection(&self, connection_id: Uuid) -> Option<u32> {
        let mut tabs = self.active_tabs.write();
        let mut connections = self.connection_mapping.write();

        if let Some(tab_id) = connections.remove(&connection_id) {
            if let Some(tab_info) = tabs.get_mut(&tab_id) {
                tab_info.connection_count = tab_info.connection_count.saturating_sub(1);
                if tab_info.connection_count == 0 {
                    tab_info.active = false;
                }
            }
            Some(tab_id)
        } else {
            None
        }
    }

    pub fn get_tab_info(&self, tab_id: u32) -> Option<TabInfo> {
        self.active_tabs.read().get(&tab_id).cloned()
    }

    pub fn get_all_tabs(&self) -> Vec<TabInfo> {
        self.active_tabs.read().values().cloned().collect()
    }

    pub fn get_active_tabs(&self) -> Vec<TabInfo> {
        self.active_tabs
            .read()
            .values()
            .filter(|tab| tab.connection_count > 0)
            .cloned()
            .collect()
    }

    pub fn update_tab_info(&self, tab_id: u32, title: Option<String>, url: Option<String>) {
        let mut tabs = self.active_tabs.write();
        if let Some(tab_info) = tabs.get_mut(&tab_id) {
            if let Some(title) = title {
                tab_info.title = Some(title);
            }
            if let Some(url) = url {
                tab_info.url = Some(url);
            }
            tab_info.last_seen = std::time::SystemTime::now();
        }
    }

    pub fn remove_tab(&self, tab_id: u32) {
        let mut tabs = self.active_tabs.write();
        tabs.remove(&tab_id);

        // Clean up connection mappings for this tab
        let mut connections = self.connection_mapping.write();
        connections.retain(|_, &mut mapped_tab_id| mapped_tab_id != tab_id);
    }

    pub fn cleanup_stale_tabs(&self, max_age: std::time::Duration) {
        let now = std::time::SystemTime::now();
        let mut tabs = self.active_tabs.write();

        tabs.retain(|_, tab_info| {
            // Keep tabs that are active or recently seen
            tab_info.connection_count > 0
                || now.duration_since(tab_info.last_seen).unwrap_or_default() <= max_age
        });
    }

    pub fn get_connection_count(&self) -> usize {
        self.connection_mapping.read().len()
    }

    pub fn get_tab_count(&self) -> usize {
        self.active_tabs.read().len()
    }

    pub fn get_active_tab_count(&self) -> usize {
        self.active_tabs
            .read()
            .values()
            .filter(|tab| tab.connection_count > 0)
            .count()
    }
}

impl Default for BrowserCommunicator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_browser_communicator() {
        let communicator = BrowserCommunicator::new();

        // Register a tab
        communicator.register_tab(1, Some("Test Page".to_string()), Some("https://example.com".to_string()));

        let tab_info = communicator.get_tab_info(1).unwrap();
        assert_eq!(tab_info.tab_id, 1);
        assert_eq!(tab_info.title, Some("Test Page".to_string()));
        assert_eq!(tab_info.connection_count, 0);

        // Associate a connection
        let connection_id = Uuid::new_v4();
        communicator.associate_connection(connection_id, 1).unwrap();

        let tab_info = communicator.get_tab_info(1).unwrap();
        assert_eq!(tab_info.connection_count, 1);

        // Disassociate the connection
        let disconnected_tab = communicator.disassociate_connection(connection_id);
        assert_eq!(disconnected_tab, Some(1));

        let tab_info = communicator.get_tab_info(1).unwrap();
        assert_eq!(tab_info.connection_count, 0);
        assert!(!tab_info.active);
    }

    #[test]
    fn test_tab_cleanup() {
        let communicator = BrowserCommunicator::new();

        communicator.register_tab(1, Some("Test".to_string()), None);
        assert_eq!(communicator.get_tab_count(), 1);

        // Simulate old tab
        std::thread::sleep(std::time::Duration::from_millis(10));
        communicator.cleanup_stale_tabs(std::time::Duration::from_millis(5));

        assert_eq!(communicator.get_tab_count(), 0);
    }
}