#!/usr/bin/env bash
# Runs the official Python itd-sdk against a local backend.
# The server must run with EMAIL_VERIFICATION=false (accounts are created through the REST API).
set -euo pipefail
cd "$(dirname "$0")"
API="${ITD_API:-http://localhost:3000/api}"
VENV="${VENV:-.venv}"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q "git+https://github.com/itd-sdk/itd-sdk"
fi
ITD_API="$API" "$VENV/bin/python" e2e_basic.py
ITD_API="$API" "$VENV/bin/python" e2e_errors.py
