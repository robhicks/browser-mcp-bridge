use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;
use uuid::Uuid;

pub struct PaginationState {
    pub data: Vec<Value>,
    pub offset: usize,
    pub created_at: Instant,
}

pub struct PaginationCursors {
    cursors: Arc<DashMap<String, PaginationState>>,
}

pub struct PaginatedResult {
    pub data: Vec<Value>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    pub total: usize,
    pub offset: usize,
    pub page_size: usize,
}

impl PaginationCursors {
    pub fn new() -> Self {
        Self {
            cursors: Arc::new(DashMap::new()),
        }
    }

    /// Clean up cursors older than 5 minutes
    pub fn cleanup_expired(&self) {
        let five_minutes = std::time::Duration::from_secs(300);
        let now = Instant::now();
        self.cursors.retain(|_, state| {
            now.duration_since(state.created_at) < five_minutes
        });
    }

    /// Generate a cursor for the next page
    fn generate_cursor(&self, data: Vec<Value>, next_offset: usize) -> String {
        let cursor_id = Uuid::new_v4().to_string();
        self.cursors.insert(cursor_id.clone(), PaginationState {
            data,
            offset: next_offset,
            created_at: Instant::now(),
        });
        self.cleanup_expired();
        cursor_id
    }

    /// Paginate array data with optional cursor-based continuation
    pub fn paginate(&self, data: Vec<Value>, cursor: Option<&str>, page_size: usize) -> PaginatedResult {
        let mut offset = 0;
        let mut data_source = data;

        // If cursor exists, use stored pagination state
        if let Some(cursor_id) = cursor {
            if let Some((_, state)) = self.cursors.remove(cursor_id) {
                offset = state.offset;
                data_source = state.data;
            }
        }

        let total = data_source.len();
        let end = (offset + page_size).min(total);
        let paginated_data: Vec<Value> = if offset < total {
            data_source[offset..end].to_vec()
        } else {
            Vec::new()
        };
        let has_more = end < total;

        let next_cursor = if has_more {
            Some(self.generate_cursor(data_source, end))
        } else {
            None
        };

        PaginatedResult {
            data: paginated_data,
            has_more,
            next_cursor,
            total,
            offset,
            page_size,
        }
    }
}

impl Default for PaginationCursors {
    fn default() -> Self {
        Self::new()
    }
}
