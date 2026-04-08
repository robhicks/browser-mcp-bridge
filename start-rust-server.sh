#!/usr/bin/env bash
#
# Start the Browser MCP Rust server with PM2
#
# Usage:
#   ./start-rust-server.sh              # Build release and start
#   ./start-rust-server.sh --no-build   # Start without rebuilding
#   ./start-rust-server.sh --dev        # Build debug and start
#   ./start-rust-server.sh --stop       # Stop the server
#   ./start-rust-server.sh --restart    # Restart the server
#   ./start-rust-server.sh --status     # Show server status
#   ./start-rust-server.sh --logs       # Tail server logs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR/rust-server"
LOG_DIR="$SCRIPT_DIR/logs"
PM2_NAME="browser-mcp-rust-server"

BUILD_MODE="release"
SKIP_BUILD=false

# Parse arguments
case "${1:-}" in
  --no-build)
    SKIP_BUILD=true
    ;;
  --dev)
    BUILD_MODE="debug"
    ;;
  --stop)
    echo "Stopping $PM2_NAME..."
    pm2 stop "$PM2_NAME" 2>/dev/null || echo "Not running."
    exit 0
    ;;
  --restart)
    echo "Restarting $PM2_NAME..."
    pm2 restart "$PM2_NAME"
    exit 0
    ;;
  --status)
    pm2 describe "$PM2_NAME" 2>/dev/null || echo "$PM2_NAME is not managed by PM2."
    exit 0
    ;;
  --logs)
    pm2 logs "$PM2_NAME"
    exit 0
    ;;
  --help|-h)
    head -14 "$0" | tail -11
    exit 0
    ;;
esac

# Ensure pm2 is available
if ! command -v pm2 &>/dev/null; then
  echo "Error: pm2 is not installed. Install with: npm install -g pm2"
  exit 1
fi

# Ensure cargo is available for building
if [ "$SKIP_BUILD" = false ] && ! command -v cargo &>/dev/null; then
  echo "Error: cargo is not installed. Install Rust from https://rustup.rs"
  exit 1
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Build the Rust server
if [ "$SKIP_BUILD" = false ]; then
  echo "Building Rust server ($BUILD_MODE)..."
  if [ "$BUILD_MODE" = "release" ]; then
    cargo build --release --manifest-path "$RUST_DIR/Cargo.toml"
    BINARY="$RUST_DIR/target/release/browser-mcp-rust-server"
  else
    cargo build --manifest-path "$RUST_DIR/Cargo.toml"
    BINARY="$RUST_DIR/target/debug/browser-mcp-rust-server"
  fi
else
  # Find existing binary, prefer release
  if [ -f "$RUST_DIR/target/release/browser-mcp-rust-server" ]; then
    BINARY="$RUST_DIR/target/release/browser-mcp-rust-server"
  elif [ -f "$RUST_DIR/target/debug/browser-mcp-rust-server" ]; then
    BINARY="$RUST_DIR/target/debug/browser-mcp-rust-server"
  else
    echo "Error: No binary found. Run without --no-build first."
    exit 1
  fi
fi

if [ ! -f "$BINARY" ]; then
  echo "Error: Build failed - binary not found at $BINARY"
  exit 1
fi

echo "Using binary: $BINARY"

# Stop existing instance if running
pm2 delete "$PM2_NAME" 2>/dev/null || true

# Start with PM2
pm2 start "$BINARY" \
  --name "$PM2_NAME" \
  --cwd "$RUST_DIR" \
  --error "$LOG_DIR/rust-server-error.log" \
  --output "$LOG_DIR/rust-server-out.log" \
  --log "$LOG_DIR/rust-server-combined.log" \
  --time \
  --max-memory-restart "512M" \
  --restart-delay 4000 \
  --max-restarts 10 \
  --kill-timeout 5000 \
  --env RUST_LOG=info

echo ""
echo "Rust server started with PM2."
echo ""
echo "  pm2 status                       # Check status"
echo "  pm2 logs $PM2_NAME   # View logs"
echo "  pm2 restart $PM2_NAME  # Restart"
echo "  pm2 stop $PM2_NAME     # Stop"
echo "  pm2 delete $PM2_NAME   # Remove"
echo ""
echo "  pm2 save     # Persist across reboots"
echo "  pm2 startup  # Enable auto-start on boot"
