#!/bin/bash
cd "$(dirname "$0")/apps/desktop"
export VITE_SIGNALING_URL="wss://worldcat-preferences-vocal-storage.trycloudflare.com"
pnpm dev
