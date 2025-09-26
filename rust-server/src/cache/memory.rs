use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

/// Memory management utilities for efficient cache operations
pub struct MemoryMonitor {
    allocated_bytes: Arc<AtomicUsize>,
    max_allocation: usize,
    allocation_warnings: Arc<AtomicUsize>,
}

impl MemoryMonitor {
    pub fn new(max_allocation_mb: usize) -> Self {
        Self {
            allocated_bytes: Arc::new(AtomicUsize::new(0)),
            max_allocation: max_allocation_mb * 1024 * 1024, // Convert to bytes
            allocation_warnings: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn allocate(&self, size: usize) -> bool {
        let current = self.allocated_bytes.fetch_add(size, Ordering::Relaxed);
        let new_total = current + size;

        if new_total > self.max_allocation {
            self.allocated_bytes.fetch_sub(size, Ordering::Relaxed);
            self.allocation_warnings.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                "Memory allocation rejected: {} bytes would exceed limit of {} bytes",
                size,
                self.max_allocation
            );
            false
        } else {
            true
        }
    }

    pub fn deallocate(&self, size: usize) {
        self.allocated_bytes.fetch_sub(size, Ordering::Relaxed);
    }

    pub fn current_usage(&self) -> usize {
        self.allocated_bytes.load(Ordering::Relaxed)
    }

    pub fn current_usage_mb(&self) -> f64 {
        self.current_usage() as f64 / (1024.0 * 1024.0)
    }

    pub fn usage_percentage(&self) -> f64 {
        (self.current_usage() as f64 / self.max_allocation as f64) * 100.0
    }

    pub fn warning_count(&self) -> usize {
        self.allocation_warnings.load(Ordering::Relaxed)
    }

    pub fn is_near_limit(&self, threshold_percentage: f64) -> bool {
        self.usage_percentage() > threshold_percentage
    }
}

/// Ring buffer implementation for console logs and network requests
/// to prevent unbounded memory growth
pub struct RingBuffer<T> {
    data: Vec<Option<T>>,
    head: usize,
    tail: usize,
    size: usize,
    capacity: usize,
}

impl<T> RingBuffer<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: (0..capacity).map(|_| None).collect(),
            head: 0,
            tail: 0,
            size: 0,
            capacity,
        }
    }

    pub fn push(&mut self, item: T) {
        if self.size == self.capacity {
            // Overwrite the oldest item
            self.data[self.tail] = Some(item);
            self.tail = (self.tail + 1) % self.capacity;
            self.head = (self.head + 1) % self.capacity;
        } else {
            self.data[self.tail] = Some(item);
            self.tail = (self.tail + 1) % self.capacity;
            self.size += 1;
        }
    }

    pub fn iter(&self) -> RingBufferIterator<T> {
        RingBufferIterator {
            buffer: self,
            current: self.head,
            remaining: self.size,
        }
    }

    pub fn len(&self) -> usize {
        self.size
    }

    pub fn is_empty(&self) -> bool {
        self.size == 0
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn clear(&mut self) {
        for item in &mut self.data {
            *item = None;
        }
        self.head = 0;
        self.tail = 0;
        self.size = 0;
    }
}

pub struct RingBufferIterator<'a, T> {
    buffer: &'a RingBuffer<T>,
    current: usize,
    remaining: usize,
}

impl<'a, T> Iterator for RingBufferIterator<'a, T> {
    type Item = &'a T;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining == 0 {
            return None;
        }

        let item = self.buffer.data[self.current].as_ref();
        self.current = (self.current + 1) % self.buffer.capacity;
        self.remaining -= 1;

        item
    }
}

/// Efficient string interning for repeated strings like URLs, selectors, etc.
pub struct StringInterner {
    strings: dashmap::DashMap<String, Arc<str>>,
    stats: Arc<std::sync::atomic::AtomicUsize>,
}

impl StringInterner {
    pub fn new() -> Self {
        Self {
            strings: dashmap::DashMap::new(),
            stats: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub fn intern(&self, s: &str) -> Arc<str> {
        if let Some(interned) = self.strings.get(s) {
            self.stats.fetch_add(1, Ordering::Relaxed); // Cache hit
            interned.clone()
        } else {
            let arc_str: Arc<str> = Arc::from(s);
            self.strings.insert(s.to_string(), arc_str.clone());
            arc_str
        }
    }

    pub fn cache_hits(&self) -> usize {
        self.stats.load(Ordering::Relaxed)
    }

    pub fn unique_strings(&self) -> usize {
        self.strings.len()
    }

    pub fn clear(&self) {
        self.strings.clear();
        self.stats.store(0, Ordering::Relaxed);
    }
}

impl Default for StringInterner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_monitor() {
        let monitor = MemoryMonitor::new(1); // 1MB limit

        // Should allow small allocations
        assert!(monitor.allocate(1024));
        assert_eq!(monitor.current_usage(), 1024);

        // Should prevent large allocations
        assert!(!monitor.allocate(2 * 1024 * 1024)); // 2MB
        assert_eq!(monitor.warning_count(), 1);

        // Should allow deallocation
        monitor.deallocate(1024);
        assert_eq!(monitor.current_usage(), 0);
    }

    #[test]
    fn test_ring_buffer() {
        let mut buffer = RingBuffer::new(3);

        buffer.push(1);
        buffer.push(2);
        buffer.push(3);
        assert_eq!(buffer.len(), 3);

        // Should overwrite oldest when at capacity
        buffer.push(4);
        assert_eq!(buffer.len(), 3);

        let items: Vec<_> = buffer.iter().cloned().collect();
        assert_eq!(items, vec![2, 3, 4]);
    }

    #[test]
    fn test_string_interner() {
        let interner = StringInterner::new();

        let s1 = interner.intern("hello");
        let s2 = interner.intern("hello");

        assert!(Arc::ptr_eq(&s1, &s2));
        assert_eq!(interner.cache_hits(), 1);
        assert_eq!(interner.unique_strings(), 1);
    }
}