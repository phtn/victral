#!/usr/bin/env bash
# Create beast project outside current directory and run dev server
TIMESTAMP=$(date +%s)
PROJECT_DIR="/tmp/beast_project_$TIMESTAMP"
echo "Creating beast project in $PROJECT_DIR"
# Create project directory
mkdir -p "$PROJECT_DIR"
# Change to project directory
cd "$PROJECT_DIR"
# Initialize beast project using bun create beast@latest
if command -v bun >/dev/null 2>&1; then
  echo "Found bun, creating beast project..."
  bun create beast@latest --yes
else
  echo "bun not found, cannot create beast project"
  exit 1
fi
# Install dependencies
echo "Installing dependencies..."
bun install
# Start dev server on port 3001
echo "Starting dev server on port 3001..."
# Use beast's dev command if available, otherwise use vite preview or http-server
if command -v beast >/dev/null 2>&1; then
  beast dev --port 3001 &
  DEV_PID=$!
else
  # Try using bun run dev or vite preview
  bun run dev --port 3001 &
  DEV_PID=$!
fi
# Wait a moment for server to start
sleep 5
# Verify server is running via curl
if curl -f http://localhost:3001 >/dev/null 2>&1; then
  echo "SUCCESS: Beast dev server is running on port 3001"
  echo "Project created at: $PROJECT_DIR"
  echo "Ready for use."
  # Write success marker
  echo "$(date)" > "$PROJECT_DIR/beast_success_marker.txt"
else
  echo "FAILURE: Could not reach dev server on port 3001"
  kill $DEV_PID 2>/dev/null
  exit 1
fi
# Keep script running or exit gracefully
echo "Beast project ready. Press Ctrl+C to stop."
wait $DEV_PID