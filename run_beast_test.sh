#!/usr/bin/env bash
# Test beast CLI availability
if command -v beast >/dev/null 2>&1; then
  echo "beast found:"
  beast --version
else
  echo "beast not found, trying bun x beast"
fi
if command -v bun >/dev/null 2>&1; then
  echo "bun found:"
  bun x beast --version 2>/dev/null || echo "bun x beast failed"
fi