@echo off
:: Klawd Nexus - Windows Installer
:: Right-click and "Run as administrator" or run from Command Prompt

echo.
echo   ◆ Klawd Nexus Installer
echo.

:: Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   Node.js is required but not installed.
    echo   Download from https://nodejs.org ^(v18 or later^)
    echo.
    pause
    exit /b 1
)

:: Check for Git
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   Git is required but not installed.
    echo   Download from https://git-scm.com
    echo.
    pause
    exit /b 1
)

set INSTALL_DIR=%USERPROFILE%\klawd-nexus

echo   [1/4] Downloading Klawd Nexus...
if exist "%INSTALL_DIR%" (
    echo   Updating existing installation...
    cd /d "%INSTALL_DIR%"
    git pull --quiet 2>nul
) else (
    git clone --quiet https://github.com/chriscode138/klawd-nexus.git "%INSTALL_DIR%"
    cd /d "%INSTALL_DIR%"
)

echo   [2/4] Installing dependencies...
call npm install --silent 2>nul

echo   [3/4] Building...
call npm run build --silent 2>nul

echo   [4/4] Creating desktop shortcut...

:: Create a launcher batch file
echo @echo off > "%INSTALL_DIR%\launch.bat"
echo cd /d "%INSTALL_DIR%" >> "%INSTALL_DIR%\launch.bat"
echo start "" npx electron . >> "%INSTALL_DIR%\launch.bat"

:: Create desktop shortcut using PowerShell
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%USERPROFILE%\Desktop\Klawd Nexus.lnk'); $s.TargetPath = '%INSTALL_DIR%\launch.bat'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.IconLocation = '%INSTALL_DIR%\icon.png'; $s.Description = 'Klawd Nexus - Multi-agent command center'; $s.WindowStyle = 7; $s.Save()" 2>nul

echo.
echo   ✓ Klawd Nexus installed successfully!
echo.
echo   Open from:
echo     - Desktop shortcut (Klawd Nexus)
echo     - Terminal: cd %INSTALL_DIR% ^&^& npm run app
echo.
echo   To run in browser: cd %INSTALL_DIR% ^&^& npm start
echo   Then open http://localhost:3000
echo.
pause
