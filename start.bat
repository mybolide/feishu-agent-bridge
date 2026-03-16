@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "START_PS1=%ROOT_DIR%scripts\start.ps1"

if not exist "%START_PS1%" (
  echo [start.bat] start.ps1 not found: "%START_PS1%"
  exit /b 1
)

REM 1 = enable auto restart on file changes (default), 0 = disable auto restart.
set "AUTO_RESTART=1"

REM 1 = skip npm install for faster startup (default), 0 = run npm install before start.
set "SKIP_INSTALL=0"

set "PS_ARGS=-Port 7071"
if "%SKIP_INSTALL%"=="1" (
  set "PS_ARGS=%PS_ARGS% -SkipInstall"
)
if not "%AUTO_RESTART%"=="1" (
  set "PS_ARGS=%PS_ARGS% -DisableAutoRestart"
)

echo [start.bat] launching gateway...
echo [start.bat] auto restart: %AUTO_RESTART%
powershell -NoProfile -ExecutionPolicy Bypass -File "%START_PS1%" %PS_ARGS% %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [start.bat] startup failed with exit code %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
