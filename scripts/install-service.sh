#!/usr/bin/env bash
# Install Intelligent Context as a systemd service (Linux) or launchd (macOS)
#
# Uses the single executable (SEA) binary produced by `npm run build:sea`.
# The binary embeds Node.js — no separate runtime needed.
#
# USAGE:
#   bash scripts/install-service.sh install
#   bash scripts/install-service.sh uninstall
#   bash scripts/install-service.sh status
#
# The first run will build the SEA binary if it doesn't exist yet.
# For distribution, ship the pre-built binary + ui/ + sql-wasm.wasm and
# set BINARY_PATH explicitly.
set -e

ACTION=${1:-install}
SERVICE_NAME=intelligent-context
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BINARY_PATH="${BINARY_PATH:-${APP_DIR}/dist/sea/intelligent-context}"
RUN_USER="${SUDO_USER:-$USER}"

if [[ "$ACTION" == "install" ]]; then
  # Build the SEA binary if it doesn't exist
  if [[ ! -f "${BINARY_PATH}" ]]; then
    echo "Single executable not found. Building..."
    cd "${APP_DIR}"
    npm ci
    npm run build:sea
    if [[ ! -f "${BINARY_PATH}" ]]; then
      echo "ERROR: Build failed. Check output above." >&2
      exit 1
    fi
  fi

  echo "Installing service from: ${BINARY_PATH}"

  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS — launchd plist
    PLIST_PATH="${HOME}/Library/LaunchAgents/com.intelligentcontext.plist"
    cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.intelligentcontext</string>
  <key>ProgramArguments</key>
  <array><string>${BINARY_PATH}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>IC_AUTO_RESTART</key><string>1</string>
  </dict>
  <key>WorkingDirectory</key><string>$(dirname "${BINARY_PATH}")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/.intelligent-context/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.intelligent-context/logs/stderr.log</string>
</dict>
</plist>
EOF
    mkdir -p "${HOME}/.intelligent-context/logs"
    launchctl load "${PLIST_PATH}"
    echo "Service installed via launchd. Will start automatically at login."

  else
    # Linux — systemd
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    sudo tee "${SERVICE_FILE}" > /dev/null <<EOF
[Unit]
Description=Intelligent Context AI Proxy
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=$(dirname "${BINARY_PATH}")
ExecStart=${BINARY_PATH}
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=NODE_NO_WARNINGS=1
Environment=IC_AUTO_RESTART=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable "${SERVICE_NAME}"
    sudo systemctl start "${SERVICE_NAME}"
    echo "Service '${SERVICE_NAME}' installed and started."
    echo "Check status: sudo systemctl status ${SERVICE_NAME}"
  fi

  echo "Proxy: http://localhost:1234/v1"
  echo "Management UI: http://localhost:9090/ui"

elif [[ "$ACTION" == "uninstall" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    PLIST_PATH="${HOME}/Library/LaunchAgents/com.intelligentcontext.plist"
    launchctl unload "${PLIST_PATH}" 2>/dev/null || true
    rm -f "${PLIST_PATH}"
  else
    sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    sudo systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    sudo systemctl daemon-reload
  fi
  echo "Service removed."

elif [[ "$ACTION" == "status" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    launchctl list | grep intelligentcontext
  else
    sudo systemctl status "${SERVICE_NAME}"
  fi
fi
