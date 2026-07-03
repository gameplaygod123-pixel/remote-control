#!/bin/bash
cd "$(dirname "$0")/apps/desktop"
export VITE_SIGNALING_URL="wss://worldcat-preferences-vocal-storage.trycloudflare.com"
export VITE_DEVICE_ID="245933258"
export VITE_PIN="807302"
pnpm dev
