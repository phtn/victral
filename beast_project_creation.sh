#!/usr/bin/env bash
# Create beast project and run dev server directly
TIMESTAMP=$(date +%s)
PROJECT_DIR="/tmp/beast_project_$TIMESTAMP"
echo "Creating beast project in $PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
# Check if bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required but not found"
  exit 1
fi
# Create beast project
echo "Creating beast project with bun create beast@latest..."
bun create beast@latest --yes
# Install dependencies
echo "Installing dependencies..."
bun install
# Start dev server
echo "Starting dev server on port 3001..."
# Try different ways to start dev server
if command -v beast >/dev/null 2>&1; then
  beast dev --port 3001 &
  DEV_PID=$!
else
  # Try bun run dev
  bun run dev --port 3001 &
  DEV_PID=$!
fi
# Wait for server to start
sleep 5
# Test server
if curl -f http://localhost:3001 >/dev/null 2>&1; then
  echo "SUCCESS: Beast dev server running on port 3001"
  echo "Project location: $PROJECT_DIR"
  echo "Ready for use."
else
  echo "FAILURE: Server not responding on port 3001"
  kill $DEV_PID 2>/dev/null
  exit 1
fi
# Keep script running
wait $DEV_PID