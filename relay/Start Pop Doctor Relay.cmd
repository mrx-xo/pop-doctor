@echo off
title Pop Doctor relay
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed, or not on the PATH.
    echo Get it from https://nodejs.org  ^(the LTS installer, all defaults^), then start this again.
    echo.
    pause
    exit /b 1
)
node "%~dp0pop-doctor-relay.mjs" %*
echo.
echo The relay stopped.
pause
