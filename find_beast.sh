#!/usr/bin/env bash
# Get current directory and search from there
cwd=$(pwd)
echo "Current directory: $cwd"
# Search up to 3 levels up for beast directories
for dir in $(pwd) $(dirname $(dirname $(pwd))) $(dirname $(dirname $(dirname $(pwd)))); do
  echo "--- Searching in: $dir ---"
  find "$dir" -name "beast" -type d 2>/dev/null | head -n 20
  find "$dir" -name "btsx" -type f 2>/dev/null | head -n 20
  echo ""
done