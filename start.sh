#!/bin/bash
set -e

# === Configuration ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/gateway-processes.json"
GATEWAY_ENTRY="$ROOT_DIR/gateway/main.js"

# Default settings
AUTO_RESTART=1
SKIP_INSTALL=0
PORT=7071

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-install|-s)
      SKIP_INSTALL=1
      shift
      ;;
    --no-restart|-n)
      AUTO_RESTART=0
      shift
      ;;
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --skip-install, -s    Skip npm install for faster startup"
      echo "  --no-restart, -n      Disable auto restart on file changes"
      echo "  --port, -p PORT       Specify port (default: 7071)"
      echo "  --help, -h            Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Create log directory
mkdir -p "$LOG_DIR"

# === Helper Functions ===

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start] $*"
}

warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [start] WARNING: $*" >&2
}

get_env_value() {
  local key="$1"
  local default="${2:-}"
  
  # Check environment variable first
  if [ -n "${!key:-}" ]; then
    echo "${!key}"
    return
  fi
  
  # Check .env file
  local env_file="$ROOT_DIR/.env"
  if [ -f "$env_file" ]; then
    local value
    value=$(grep -E "^${key}=" "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2-)
    if [ -n "$value" ]; then
      # Remove quotes
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      echo "$value"
      return
    fi
  fi
  
  echo "$default"
}

check_port() {
  local host="$1"
  local port="$2"
  
  if command -v nc &>/dev/null; then
    nc -z "$host" "$port" 2>/dev/null
    return $?
  elif command -v lsof &>/dev/null; then
    lsof -i ":$port" &>/dev/null
    return $?
  else
    # Fallback: try to connect with bash
    (echo >/dev/tcp/"$host"/"$port") 2>/dev/null
    return $?
  fi
}

kill_process_on_port() {
  local port="$1"
  local reason="${2:-restart}"
  
  if command -v lsof &>/dev/null; then
    local pids
    pids=$(lsof -t -i ":$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      for pid in $pids; do
        if [ "$pid" != "$$" ]; then
          log "killing process $pid on port $port ($reason)"
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
      sleep 0.5
      return 0
    fi
  fi
  return 1
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local rounds="${3:-20}"
  
  for ((i=0; i<rounds; i++)); do
    if check_port "$host" "$port"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

check_opencode_health() {
  local server_url="$1"
  local health_url="${server_url%/}/global/health"
  
  if command -v curl &>/dev/null; then
    local response
    response=$(curl -s -m 3 "$health_url" 2>/dev/null || echo "")
    if [ -n "$response" ]; then
      if echo "$response" | grep -q '"healthy"[[:space:]]*:[[:space:]]*true'; then
        return 0
      fi
    fi
  fi
  return 1
}

write_pid_file() {
  local gateway_pid="$1"
  local opencode_pid="${2:-0}"
  
  cat > "$PID_FILE" << EOF
{
  "projectRoot": "$ROOT_DIR",
  "updatedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "gatewayPid": $gateway_pid,
  "opencodePid": $opencode_pid,
  "extraPids": []
}
EOF
  log "pid file updated: $PID_FILE (gateway=$gateway_pid, opencode=$opencode_pid)"
}

find_gateway_pids() {
  local pids=""
  
  if command -v pgrep &>/dev/null; then
    pids=$(pgrep -f "node.*gateway/main.js" 2>/dev/null || true)
  else
    pids=$(ps aux | grep -E "node.*gateway/main.js" | grep -v grep | awk '{print $2}' | tr '\n' ' ')
  fi
  
  echo "$pids"
}

kill_gateway_processes() {
  local pids
  pids=$(find_gateway_pids)
  
  if [ -n "$pids" ]; then
    for pid in $pids; do
      if [ "$pid" != "$$" ]; then
        log "killing existing gateway process: $pid"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
    sleep 1
  fi
}

# === Main ===

log "starting feishu-agent-bridge..."
log "ROOT_DIR: $ROOT_DIR"
log "AUTO_RESTART: $AUTO_RESTART"
log "SKIP_INSTALL: $SKIP_INSTALL"
log "PORT: $PORT"

# Check required files
if [ ! -f "$ROOT_DIR/package.json" ]; then
  warn "package.json not found: $ROOT_DIR/package.json"
  exit 1
fi

if [ ! -f "$GATEWAY_ENTRY" ]; then
  warn "gateway entry not found: $GATEWAY_ENTRY"
  exit 1
fi

# Kill existing gateway processes
kill_gateway_processes

# Clean up PID file
rm -f "$PID_FILE"

# Install dependencies
if [ "$SKIP_INSTALL" -eq 0 ]; then
  log "syncing node dependencies..."
  (cd "$ROOT_DIR" && npm install)
fi

# === OpenCode Server Setup ===
OPENCODE_PID=0
OPENCODE_SERVER_URL=$(get_env_value "OPENCODE_SERVER_URL" "http://127.0.0.1:24096")

# Parse server URL
OPENCODE_HOST="127.0.0.1"
OPENCODE_PORT=24096

if [[ "$OPENCODE_SERVER_URL" =~ ^https?://([^:]+):([0-9]+) ]]; then
  OPENCODE_HOST="${BASH_REMATCH[1]}"
  OPENCODE_PORT="${BASH_REMATCH[2]}"
fi

log "OpenCode server URL: $OPENCODE_SERVER_URL"

# Check if OpenCode is already healthy
if check_opencode_health "$OPENCODE_SERVER_URL"; then
  log "OpenCode server already healthy at $OPENCODE_SERVER_URL"
  export OPENCODE_SERVER_URL
else
  # Check if port is in use
  if check_port "$OPENCODE_HOST" "$OPENCODE_PORT"; then
    warn "port $OPENCODE_PORT is in use but OpenCode is not healthy"
    kill_process_on_port "$OPENCODE_PORT" "stale process"
  fi
  
  # Try to start OpenCode server
  log "starting OpenCode server on $OPENCODE_HOST:$OPENCODE_PORT ..."
  
  OPENCODE_CMD=""
  
  # Find opencode command
  if command -v opencode &>/dev/null; then
    OPENCODE_CMD="opencode"
  elif [ -n "$(get_env_value 'OPENCODE_COMMAND')" ]; then
    OPENCODE_CMD=$(get_env_value "OPENCODE_COMMAND")
  fi
  
  if [ -n "$OPENCODE_CMD" ]; then
    # Start OpenCode server in background
    OPENCODE_OUT_LOG="$LOG_DIR/opencode-serve.out.log"
    OPENCODE_ERR_LOG="$LOG_DIR/opencode-serve.err.log"
    
    rm -f "$OPENCODE_OUT_LOG" "$OPENCODE_ERR_LOG"
    
    "$OPENCODE_CMD" serve --hostname "$OPENCODE_HOST" --port "$OPENCODE_PORT" \
      > "$OPENCODE_OUT_LOG" 2> "$OPENCODE_ERR_LOG" &
    OPENCODE_PID=$!
    
    log "OpenCode server started with PID: $OPENCODE_PID"
    
    # Wait for server to be ready
    if wait_for_port "$OPENCODE_HOST" "$OPENCODE_PORT" 10 && check_opencode_health "$OPENCODE_SERVER_URL"; then
      log "OpenCode server ready at $OPENCODE_SERVER_URL"
      export OPENCODE_SERVER_URL
    else
      warn "OpenCode server failed to start or health check failed"
      warn "see logs: $OPENCODE_OUT_LOG / $OPENCODE_ERR_LOG"
      OPENCODE_PID=0
    fi
  else
    warn "opencode command not found, skipping OpenCode server startup"
    warn "install opencode or set OPENCODE_COMMAND in .env"
  fi
fi

# === Start Gateway ===

GATEWAY_OUT_LOG="$LOG_DIR/node-gateway.out.log"
GATEWAY_ERR_LOG="$LOG_DIR/node-gateway.err.log"

rm -f "$GATEWAY_OUT_LOG" "$GATEWAY_ERR_LOG"

export NODE_GATEWAY_PORT="$PORT"

log "launching gateway..."

if [ "$AUTO_RESTART" -eq 1 ]; then
  log "auto restart: enabled (using --watch)"
  node --watch "$GATEWAY_ENTRY" > "$GATEWAY_OUT_LOG" 2> "$GATEWAY_ERR_LOG" &
else
  log "auto restart: disabled"
  node "$GATEWAY_ENTRY" > "$GATEWAY_OUT_LOG" 2> "$GATEWAY_ERR_LOG" &
fi

GATEWAY_PID=$!
log "gateway started with PID: $GATEWAY_PID"

# Write PID file
write_pid_file "$GATEWAY_PID" "$OPENCODE_PID"

# Wait for gateway to be ready
sleep 2

# Check if process is still running
if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  warn "gateway process exited unexpectedly"
  warn "see logs: $GATEWAY_OUT_LOG / $GATEWAY_ERR_LOG"
  if [ -f "$GATEWAY_OUT_LOG" ]; then
    tail -50 "$GATEWAY_OUT_LOG"
  fi
  if [ -f "$GATEWAY_ERR_LOG" ]; then
    tail -50 "$GATEWAY_ERR_LOG"
  fi
  exit 1
fi

# Check readiness in logs
CONNECTION_MODE=$(get_env_value "FEISHU_CONNECTION_MODE" "long_connection")
log "connection mode: $CONNECTION_MODE"

if [ "$CONNECTION_MODE" = "long_connection" ]; then
  # Wait for long connection to be established
  for ((i=0; i<30; i++)); do
    if [ -f "$GATEWAY_OUT_LOG" ]; then
      if grep -q "\[feishu\] long connection started" "$GATEWAY_OUT_LOG" 2>/dev/null; then
        log "gateway ready (long connection established)"
        break
      fi
    fi
    sleep 1
  done
fi

log "done."
log "gateway PID: $GATEWAY_PID"
log "opencode PID: $OPENCODE_PID"
log "logs: $GATEWAY_OUT_LOG"

# Keep script running to maintain background processes
wait "$GATEWAY_PID"