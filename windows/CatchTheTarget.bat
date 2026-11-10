@echo off
setlocal
rem ============================================================
rem  Catch the Target  -  double-click to start
rem
rem  Starts the game server on this PC, opens the game full-screen
rem  and shows the link to open on the registration tablet.
rem  The tablet must be on the same Wi-Fi / network as this PC.
rem ============================================================
title Catch the Target - server (keep this window open)
cd /d "%~dp0"

if not exist "CatchTheTarget.exe" (
  echo.
  echo  CatchTheTarget.exe was not found next to this file.
  echo  Keep CatchTheTarget.bat and CatchTheTarget.exe in the same folder.
  echo.
  pause
  exit /b 1
)

rem --- port (default 7420, can be changed in settings.txt with  port=7421 ) ---
set "PORT=7420"
if exist "settings.txt" (
  for /f "usebackq tokens=1,2 delims== " %%A in ("settings.txt") do (
    if /i "%%A"=="port" set "PORT=%%B"
  )
)

rem --- one-time: let the tablet reach this PC through Windows Firewall ---
netsh advfirewall firewall show rule name="CatchTheTarget-%PORT%" >nul 2>&1
if errorlevel 1 (
  echo.
  echo  First run: allowing the registration tablet to connect to this PC.
  echo  Please click "Yes" on the Windows prompt.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath 'netsh.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'advfirewall','firewall','add','rule','name=CatchTheTarget-%PORT%','dir=in','action=allow','protocol=TCP','localport=%PORT%','profile=any' } catch { exit 1 }"
  netsh advfirewall firewall show rule name="CatchTheTarget-%PORT%" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo  ! The firewall rule was not added. The game will still run on this PC,
    echo    but the tablet may not be able to connect. If Windows asks
    echo    "Allow access?" for CatchTheTarget, tick Private and Public and click Allow.
    echo.
  ) else (
    echo  Done.
  )
)

rem --- start the server + game (this window shows the tablet link) ---
"%~dp0CatchTheTarget.exe" -port %PORT% %*
