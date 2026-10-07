#!/usr/bin/env bash
# Find beast project directories
find /Users -name "beast" -type d 2>/dev/null | head -n 20
find /Users -name "btsx" -type f 2>/dev/null | head -n 20
find /Users -name "beast" -type f 2>/dev/null | grep -E "\.js$|\.ts$|\.json$" | head -n 20