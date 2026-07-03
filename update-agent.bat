@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   กำลังตรวจสอบอัปเดต...
echo ========================================
echo.

for /f %%i in ('git rev-parse HEAD') do set OLDCOMMIT=%%i

git pull

for /f %%i in ('git rev-parse HEAD') do set NEWCOMMIT=%%i

echo.

if "%OLDCOMMIT%"=="%NEWCOMMIT%" (
    echo ไม่มีอัปเดตใหม่ครับ ใช้เวอร์ชันล่าสุดอยู่แล้ว
) else (
    echo ========================================
    echo   สิ่งที่อัปเดตในรอบนี้:
    echo ========================================
    git log --pretty=format:"  - %%s" %OLDCOMMIT%..%NEWCOMMIT%
    echo.
    echo.
    echo ========================================
    echo   กำลังอัปเดตไลบรารี ถ้ามีการเปลี่ยนแปลง...
    echo ========================================
    call pnpm.cmd install
    echo.
    echo ========================================
    echo   อัปเดตเสร็จแล้ว!
    echo   ปิดหน้าต่าง Agent ตัวเก่า ^(ถ้ายังเปิดอยู่^)
    echo   แล้วเปิด start-agent ใหม่อีกครั้ง
    echo ========================================
)

pause
