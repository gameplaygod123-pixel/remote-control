@echo off
cd /d "%~dp0apps\desktop"
set APP_MODE=agent
set VITE_SIGNALING_URL=wss://directly-sought-laboratory-waiver.trycloudflare.com
call pnpm.cmd dev
pause
