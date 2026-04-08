#!/usr/bin/env bash
#
# Install the Browser MCP Rust server as a systemd user service.
#
# Usage:
#   ./install-rust-service.sh              # Build release and install service
#   ./install-rust-service.sh --no-build   # Install without rebuilding
#   ./install-rust-service.sh --uninstall  # Remove the service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR/rust-server"
SERVICE_NAME="browser-mcp-rust-server"
SERVICE_FILE="$SCRIPT_DIR/$SERVICE_NAME.service"
USER_SERVICE_DIR="$HOME/.config/systemd/user"

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
  echo "Stopping and disabling $SERVICE_NAME..."
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$USER_SERVICE_DIR/$SERVICE_NAME.service"
  systemctl --user daemon-reload
  echo "Service removed."
  exit 0
fi

# --- Build ---
if [ "${1:-}" != "--no-build" ]; then
  if ! command -v cargo &>/dev/null; then
    echo "Error: cargo is not installed. Install Rust from https://rustup.rs"
    exit 1
  fi
  echo "Building Rust server (release)..."
  cargo build --release --manifest-path "$RUST_DIR/Cargo.toml"
fi

BINARY="$RUST_DIR/target/release/browser-mcp-rust-server"
if [ ! -f "$BINARY" ]; then
  echo "Error: Binary not found at $BINARY"
  echo "Run without --no-build first."
  exit 1
fi

# --- Update service file paths ---
# The shipped service file uses %h (home dir specifier), which systemd
# expands automatically. Verify the binary is where the unit expects it.
EXPECTED_PATH="$HOME/dev/browser-mcp-bridge/rust-server/target/release/browser-mcp-rust-server"
if [ "$BINARY" != "$EXPECTED_PATH" ]; then
  echo "Warning: Your repo is not at ~/dev/browser-mcp-bridge"
  echo "Generating a service file with the correct paths..."
  SERVICE_FILE="$SCRIPT_DIR/$SERVICE_NAME.generated.service"
  sed \
    -e "s|%h/dev/browser-mcp-bridge/rust-server|$RUST_DIR|g" \
    "$SCRIPT_DIR/$SERVICE_NAME.service" > "$SERVICE_FILE"
  echo "Generated: $SERVICE_FILE"
fi

# --- Install ---
mkdir -p "$USER_SERVICE_DIR"
cp "$SERVICE_FILE" "$USER_SERVICE_DIR/$SERVICE_NAME.service"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user start "$SERVICE_NAME"

echo ""
echo "Service installed and started."
echo ""
echo "  systemctl --user status $SERVICE_NAME    # Check status"
echo "  journalctl --user -u $SERVICE_NAME -f    # Follow logs"
echo "  systemctl --user restart $SERVICE_NAME   # Restart"
echo "  systemctl --user stop $SERVICE_NAME      # Stop"
echo ""
echo "The service will auto-start on login. To also start it before"
echo "logging in (e.g. for SSH sessions), run:"
echo ""
echo "  loginctl enable-linger \$USER"
