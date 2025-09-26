use crate::types::{errors::*, messages::*};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug)]
pub struct RequestTracker {
    pub request_id: Uuid,
    pub start_time: Instant,
    pub timeout: Duration,
    pub retry_count: usize,
    pub max_retries: usize,
}

impl RequestTracker {
    pub fn new(timeout: Duration, max_retries: usize) -> Self {
        Self {
            request_id: Uuid::new_v4(),
            start_time: Instant::now(),
            timeout,
            retry_count: 0,
            max_retries,
        }
    }

    pub fn is_expired(&self) -> bool {
        self.start_time.elapsed() > self.timeout
    }

    pub fn can_retry(&self) -> bool {
        self.retry_count < self.max_retries
    }

    pub fn retry(&mut self) -> bool {
        if self.can_retry() {
            self.retry_count += 1;
            self.request_id = Uuid::new_v4(); // New ID for retry
            true
        } else {
            false
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.start_time.elapsed()
    }
}

#[derive(Debug, Clone)]
pub struct RequestMetrics {
    pub total_requests: u64,
    pub successful_requests: u64,
    pub failed_requests: u64,
    pub timeout_requests: u64,
    pub retry_requests: u64,
    pub average_response_time: Duration,
    pub max_response_time: Duration,
    pub min_response_time: Duration,
}

impl Default for RequestMetrics {
    fn default() -> Self {
        Self {
            total_requests: 0,
            successful_requests: 0,
            failed_requests: 0,
            timeout_requests: 0,
            retry_requests: 0,
            average_response_time: Duration::ZERO,
            max_response_time: Duration::ZERO,
            min_response_time: Duration::MAX,
        }
    }
}

pub struct RequestHandler {
    metrics: parking_lot::RwLock<RequestMetrics>,
    response_times: parking_lot::RwLock<Vec<Duration>>,
    max_history: usize,
}

impl RequestHandler {
    pub fn new(max_history: usize) -> Self {
        Self {
            metrics: parking_lot::RwLock::new(RequestMetrics::default()),
            response_times: parking_lot::RwLock::new(Vec::new()),
            max_history,
        }
    }

    pub fn record_request_start(&self) -> Instant {
        let mut metrics = self.metrics.write();
        metrics.total_requests += 1;
        Instant::now()
    }

    pub fn record_request_success(&self, start_time: Instant) {
        let duration = start_time.elapsed();
        let mut metrics = self.metrics.write();
        let mut response_times = self.response_times.write();

        metrics.successful_requests += 1;

        // Update response time statistics
        if duration > metrics.max_response_time {
            metrics.max_response_time = duration;
        }
        if duration < metrics.min_response_time {
            metrics.min_response_time = duration;
        }

        // Maintain response time history
        response_times.push(duration);
        if response_times.len() > self.max_history {
            response_times.remove(0);
        }

        // Recalculate average
        if !response_times.is_empty() {
            let total: Duration = response_times.iter().sum();
            metrics.average_response_time = total / response_times.len() as u32;
        }
    }

    pub fn record_request_failure(&self, _start_time: Instant, error: &BrowserMcpError) {
        let mut metrics = self.metrics.write();
        metrics.failed_requests += 1;

        match error {
            BrowserMcpError::RequestTimeout { .. } => {
                metrics.timeout_requests += 1;
            }
            _ => {}
        }
    }

    pub fn record_request_retry(&self) {
        let mut metrics = self.metrics.write();
        metrics.retry_requests += 1;
    }

    pub fn get_metrics(&self) -> RequestMetrics {
        self.metrics.read().clone()
    }

    pub fn get_success_rate(&self) -> f64 {
        let metrics = self.metrics.read();
        if metrics.total_requests == 0 {
            0.0
        } else {
            metrics.successful_requests as f64 / metrics.total_requests as f64
        }
    }

    pub fn get_error_rate(&self) -> f64 {
        let metrics = self.metrics.read();
        if metrics.total_requests == 0 {
            0.0
        } else {
            metrics.failed_requests as f64 / metrics.total_requests as f64
        }
    }

    pub fn reset_metrics(&self) {
        *self.metrics.write() = RequestMetrics::default();
        self.response_times.write().clear();
    }
}

#[derive(Debug)]
pub struct BatchRequest {
    pub requests: Vec<(u32, BrowserRequest)>, // (tab_id, request)
    pub timeout: Duration,
    pub max_parallel: usize,
}

impl BatchRequest {
    pub fn new(timeout: Duration, max_parallel: usize) -> Self {
        Self {
            requests: Vec::new(),
            timeout,
            max_parallel,
        }
    }

    pub fn add_request(&mut self, tab_id: u32, request: BrowserRequest) {
        self.requests.push((tab_id, request));
    }

    pub fn is_empty(&self) -> bool {
        self.requests.is_empty()
    }

    pub fn len(&self) -> usize {
        self.requests.len()
    }
}

#[derive(Debug)]
pub struct BatchResponse {
    pub responses: Vec<(u32, Result<BrowserResponse>)>, // (tab_id, response)
    pub completed: usize,
    pub failed: usize,
    pub elapsed: Duration,
}

impl BatchResponse {
    pub fn success_rate(&self) -> f64 {
        let total = self.completed + self.failed;
        if total == 0 {
            0.0
        } else {
            self.completed as f64 / total as f64
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_tracker() {
        let mut tracker = RequestTracker::new(Duration::from_secs(5), 3);

        assert!(tracker.can_retry());
        assert!(!tracker.is_expired());

        tracker.retry();
        assert_eq!(tracker.retry_count, 1);
        assert!(tracker.can_retry());

        // Simulate retries until max reached
        tracker.retry();
        tracker.retry();
        assert_eq!(tracker.retry_count, 3);
        assert!(!tracker.can_retry());
    }

    #[test]
    fn test_request_handler_metrics() {
        let handler = RequestHandler::new(100);

        let start_time = handler.record_request_start();
        std::thread::sleep(Duration::from_millis(10));
        handler.record_request_success(start_time);

        let metrics = handler.get_metrics();
        assert_eq!(metrics.total_requests, 1);
        assert_eq!(metrics.successful_requests, 1);
        assert!(metrics.average_response_time >= Duration::from_millis(10));

        assert_eq!(handler.get_success_rate(), 1.0);
        assert_eq!(handler.get_error_rate(), 0.0);
    }

    #[test]
    fn test_batch_request() {
        let mut batch = BatchRequest::new(Duration::from_secs(30), 5);

        assert!(batch.is_empty());

        batch.add_request(1, BrowserRequest::GetPageContent { include_metadata: true });
        batch.add_request(2, BrowserRequest::GetDomSnapshot { max_depth: 10, include_styles: false });

        assert_eq!(batch.len(), 2);
        assert!(!batch.is_empty());
    }
}