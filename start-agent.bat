@echo off
cd /d "%~dp0apps\desktop"
set APP_MODE=agent
set VITE_SIGNALING_URL=wss://worldcat-preferences-vocal-storage.trycloudflare.com
call pnpm.cmd dev
pause
