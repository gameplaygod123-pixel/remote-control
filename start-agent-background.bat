@echo off
cd /d "%~dp0apps\desktop"
set APP_MODE=agent
set VITE_SIGNALING_URL=wss://worldcat-preferences-vocal-storage.trycloudflare.com
set VITE_PIN=807302
set START_HIDDEN=1
call pnpm.cmd dev
