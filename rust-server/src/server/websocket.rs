use crate::server::SimpleBrowserMcpServer;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

pub async fn start_websocket_server(
    mcp_handler: Arc<SimpleBrowserMcpServer>,
    host: &str,
    port: u16,
) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/ws", get(handle_websocket_upgrade))
        .route("/health", get(handle_health_check))
        .layer(CorsLayer::permissive())
        .with_state(mcp_handler);

    let addr = format!("{}:{}", host, port);
    let listener = TcpListener::bind(&addr).await?;

    tracing::info!("WebSocket server listening on ws://{}/ws", addr);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

async fn handle_websocket_upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(server): State<Arc<SimpleBrowserMcpServer>>,
) -> impl IntoResponse {
    tracing::info!("WebSocket upgrade request from {}", addr);
    ws.on_upgrade(move |socket| handle_websocket_connection(socket, addr, server))
}

async fn handle_websocket_connection(
    socket: WebSocket,
    addr: SocketAddr,
    server: Arc<SimpleBrowserMcpServer>,
) {
    tracing::info!("New WebSocket connection from {}", addr);
    server
        .connection_pool
        .handle_connection(socket, Some(addr))
        .await;
}

async fn handle_health_check(
    State(server): State<Arc<SimpleBrowserMcpServer>>,
) -> impl IntoResponse {
    use axum::{http::StatusCode, Json};

    let health_status = server.get_health_status().await;
    (StatusCode::OK, Json(health_status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerConfig;
    use axum_test::TestServer;
    use tokio_tungstenite::{connect_async, tungstenite::Message as TungsteniteMessage};

    #[tokio::test]
    async fn test_websocket_server_creation() {
        let config = ServerConfig::default();
        let server = Arc::new(SimpleBrowserMcpServer::new(config).await.unwrap());

        let app = Router::new()
            .route("/ws", get(handle_websocket_upgrade))
            .route("/health", get(handle_health_check))
            .layer(CorsLayer::permissive())
            .with_state(server);

        let test_server = TestServer::new(app).unwrap();
        let response = test_server.get("/health").await;
        assert_eq!(response.status_code(), 200);
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let config = ServerConfig::default();
        let server = Arc::new(SimpleBrowserMcpServer::new(config).await.unwrap());

        let app = Router::new()
            .route("/health", get(handle_health_check))
            .with_state(server);

        let test_server = TestServer::new(app).unwrap();
        let response = test_server.get("/health").await;

        assert_eq!(response.status_code(), 200);
        let health_status: serde_json::Value = response.json();
        assert_eq!(health_status["status"], "healthy");
        assert!(health_status["version"].is_string());
    }
}