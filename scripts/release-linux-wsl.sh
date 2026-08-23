#!/usr/bin/env bash
set -euo pipefail

WIN_PROJECT="/mnt/g/Custom_Projects/Custom_Apps/google-voice-desktop-app"
WSL_BUILD_ROOT="$HOME/wsl-build"
WSL_PROJECT="$WSL_BUILD_ROOT/google-voice-desktop-app"

mkdir -p "$WSL_BUILD_ROOT"
rm -rf "$WSL_PROJECT"
cp -a "$WIN_PROJECT" "$WSL_PROJECT"

cd "$WSL_PROJECT"
rm -rf dist/linux

# Use dotenv if present
if [ -f ".env" ]; then
  npx dotenv -e .env -- electron-builder --linux --x64 --publish always
else
  npx electron-builder --linux --x64 --publish always
fi

# Copy artifacts back to Windows repo
mkdir -p "$WIN_PROJECT/dist/linux"
cp -f dist/linux/*.AppImage "$WIN_PROJECT/dist/linux/" || true
cp -f dist/linux/*.yml "$WIN_PROJECT/dist/linux/" 2>/dev/null || true
cp -f dist/linux/*.blockmap "$WIN_PROJECT/dist/linux/" 2>/dev/null || true

echo "Linux release artifacts copied to Windows dist/linux"
