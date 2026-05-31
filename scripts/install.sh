#!/usr/bin/env bash
set -euo pipefail

# ACO — OpenClaw extension installer
# Usage: bash scripts/install.sh [--dry-run]

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

# ── Detect OpenClaw root ──────────────────────────────────────────
if [ -n "${OPENCLAW_HOME:-}" ]; then
  OPENCLAW_ROOT="$OPENCLAW_HOME"
elif [ -d "$HOME/.openclaw" ]; then
  OPENCLAW_ROOT="$HOME/.openclaw"
elif [ -d "/root/.openclaw" ]; then
  OPENCLAW_ROOT="/root/.openclaw"
else
  echo "ERROR: Cannot find OpenClaw installation."
  echo "  Tried: \$OPENCLAW_HOME, ~/.openclaw, /root/.openclaw"
  echo "  Set \$OPENCLAW_HOME to your OpenClaw root and re-run."
  exit 1
fi

echo "  OpenClaw root: $OPENCLAW_ROOT"

# ── Locate extensions source ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ACO_DIR/extensions"

if [ ! -d "$SRC" ]; then
  echo "ERROR: extensions/ directory not found at $SRC"
  exit 1
fi

EXT_TARGET="$OPENCLAW_ROOT/extensions"

if [ ! -d "$EXT_TARGET" ]; then
  echo "ERROR: target extension directory does not exist: $EXT_TARGET"
  echo "  Create it first: mkdir -p \"$EXT_TARGET\""
  exit 1
fi

# ── Gather what will be copied ────────────────────────────────────
EXTENSIONS=()
for ext in "$SRC"/aco-*; do
  [ -d "$ext" ] && EXTENSIONS+=("$(basename "$ext")")
done

if [ ${#EXTENSIONS[@]} -eq 0 ]; then
  echo "ERROR: no aco-* extension directories found under $SRC"
  exit 1
fi

echo "  Extensions to install: ${#EXTENSIONS[@]}"
for ext in "${EXTENSIONS[@]}"; do
  echo "    - $ext"
done

# ── Dry-run ────────────────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "Dry-run mode — no changes made."
  echo "Would run:"
  for ext in "${EXTENSIONS[@]}"; do
    echo "  cp -R \"$SRC/$ext\" \"$EXT_TARGET/\""
  done
  echo "  openclaw doctor --non-interactive --no-workspace-suggestions"
  exit 0
fi

# ── Copy extensions ───────────────────────────────────────────────
echo ""
echo "Installing..."
for ext in "${EXTENSIONS[@]}"; do
  cp -R "$SRC/$ext" "$EXT_TARGET/"
  echo "  ✓ $ext"
done

echo ""
echo "  Copied ${#EXTENSIONS[@]} extensions to $EXT_TARGET"

# ── Run doctor if available ──────────────────────────────────────
if command -v openclaw &>/dev/null; then
  echo ""
  echo "Running openclaw doctor..."
  if openclaw doctor --non-interactive --no-workspace-suggestions 2>/dev/null; then
    echo "  ✓ doctor passed"
  else
    echo "  ⚠ doctor reported issues — inspect with 'openclaw doctor'"
  fi
else
  echo ""
  echo "  (skipped doctor — 'openclaw' command not found in PATH)"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "  ACO extensions installed successfully"
echo "  Target: $EXT_TARGET"
echo "  Extensions: ${#EXTENSIONS[@]}"
echo "────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  1. aco init       # Initialize ACO configuration"
echo "  2. openclaw doctor # Verify health"
echo "  3. openclaw gateway restart  # Apply changes"
