#!/usr/bin/env bash
# Create beast project outside current directory
# Get current directory
current_dir=$(pwd)
# Create parent directory for beast project
beast_parent="/tmp/beast_project_$(date +%s)
mkdir -p "$beast_parent"
# Navigate to parent directory
cd "$beast_parent"
# Check if beast CLI is available via bun
if command -v bun >/dev/null 2>&1; then
  echo "Creating beast project using bun..."
  bun create beast@latest --cwd "$beast_parent"
else
  echo "bun not found, trying beast directly"
  beast create --cwd "$beast_parent"
fi
# Navigate to created project
cd "$(find "$beast_parent" -maxdepth 1 -type d -name "beast*" 2>/dev/null | head -n 1)"
# Install dependencies
if [ -f "package.json" ]; then
  bun install
fi
# Run dev server on port 3001
echo "Starting dev server on port 3001..."
bun run dev --port 3001 &
# Wait a bit for server is running
sleep 2
# Verify server is running
if curl -s http://localhost:3001 | grep -q "beast"; then
  echo "Beast project successfully created and running!"
  echo "Project location: $beast_parent"
  echo "Dev server running on port 3001"
else
  echo "Server verification failed"
fi