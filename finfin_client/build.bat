@echo off
REM FinFin — Build script
REM  1. PyInstaller  → dist\FinFin.exe
REM  2. Inno Setup   → installer\FinFin_Setup.exe  (ถ้าติดตั้ง Inno Setup ไว้)
REM
REM ติดตั้ง Inno Setup: https://jrsoftware.org/isdl.php

cd /d "%~dp0"

echo [1/2] Building FinFin.exe with PyInstaller...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

python -m PyInstaller ^
  --noconfirm ^
  --onefile ^
  --windowed ^
  --name "FinFin" ^
  --hidden-import customtkinter ^
  main.py

if not exist "dist\FinFin.exe" (
  echo ERROR: PyInstaller failed — dist\FinFin.exe not found
  pause & exit /b 1
)
echo   OK: dist\FinFin.exe

echo.
echo [2/2] Building installer with Inno Setup...

REM ค้นหา ISCC.exe ใน path ทั่วไป
set ISCC=
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
if exist "C:\Program Files\Inno Setup 6\ISCC.exe"       set ISCC=C:\Program Files\Inno Setup 6\ISCC.exe
if exist "C:\Program Files (x86)\Inno Setup 5\ISCC.exe" set ISCC=C:\Program Files (x86)\Inno Setup 5\ISCC.exe

if "%ISCC%"=="" (
  echo   SKIP: ไม่พบ Inno Setup
  echo         ดาวน์โหลดได้ที่ https://jrsoftware.org/isdl.php
  echo         แล้วรัน build.bat อีกครั้ง
) else (
  if not exist "installer" mkdir installer
  "%ISCC%" installer.iss
  if exist "installer\FinFin_Setup.exe" (
    echo   OK: installer\FinFin_Setup.exe
  ) else (
    echo   ERROR: Inno Setup compile failed
  )
)

echo.
echo ==============================
echo   dist\FinFin.exe          (รันตรง)
echo   installer\FinFin_Setup.exe  (ส่งให้ลูกค้า)
echo ==============================
pause
