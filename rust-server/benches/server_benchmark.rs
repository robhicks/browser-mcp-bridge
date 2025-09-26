use browser_mcp_rust_server::{BrowserMcpServer, ServerConfig};
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::sync::Arc;
use tokio::runtime::Runtime;

fn benchmark_server_creation(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    c.bench_function("server_creation", |b| {
        b.to_async(&rt).iter(|| async {
            let config = ServerConfig::default();
            black_box(BrowserMcpServer::new(config).await.unwrap());
        });
    });
}

fn benchmark_json_processing(c: &mut Criterion) {
    c.bench_function("parse_mcp_request", |b| {
        let request_json = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_page_content","arguments":{"tabId":1}}}"#;

        b.iter(|| {
            let _: serde_json::Value = serde_json::from_str(black_box(request_json)).unwrap();
        });
    });

    c.bench_function("serialize_response", |b| {
        let response = serde_json::json!({
            "content": [{
                "type": "text",
                "text": "Sample page content response"
            }]
        });

        b.iter(|| {
            black_box(serde_json::to_string(&response).unwrap());
        });
    });
}

fn benchmark_cache_operations(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    c.bench_function("cache_insert_and_get", |b| {
        b.to_async(&rt).iter(|| async {
            let config = ServerConfig::default();
            let server = BrowserMcpServer::new(config).await.unwrap();

            let page_content = browser_mcp_rust_server::PageContent {
                url: "https://example.com".to_string(),
                title: "Test Page".to_string(),
                text: "Sample content".repeat(1000),
                html: "<html><body>Sample content</body></html>".repeat(100),
                metadata: std::collections::HashMap::new(),
                last_updated: std::time::SystemTime::now(),
            };

            // Insert into cache
            server.data_cache.update_page_content(1, page_content).await;

            // Retrieve from cache
            black_box(server.data_cache.get_page_content(1).await);
        });
    });
}

fn benchmark_connection_management(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    c.bench_function("connection_pool_operations", |b| {
        b.to_async(&rt).iter(|| async {
            let config = ServerConfig::default();
            let server = BrowserMcpServer::new(config).await.unwrap();

            // Simulate connection operations
            let connection_id = uuid::Uuid::new_v4();
            server.data_cache.register_connection(connection_id, 1).await;
            black_box(server.data_cache.get_connections_for_tab(1).await);
            server.data_cache.unregister_connection(connection_id).await;
        });
    });
}

criterion_group!(
    benches,
    benchmark_server_creation,
    benchmark_json_processing,
    benchmark_cache_operations,
    benchmark_connection_management
);
criterion_main!(benches);