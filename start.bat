@echo off
title ShapeForge Dev Server
cd /d "%~dp0"

where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    if exist "%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ShapeForgeRuntime\node-v24.19.0-win-x64\npm.cmd" (
        set "PATH=%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ShapeForgeRuntime\node-v24.19.0-win-x64;%PATH%"
    ) else if exist "C:\Users\morow-vm\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ShapeForgeRuntime\node-v24.19.0-win-x64\npm.cmd" (
        set "PATH=C:\Users\morow-vm\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ShapeForgeRuntime\node-v24.19.0-win-x64;%PATH%"
    )
)

echo Starting ShapeForge development server at http://localhost:5173/ ...
call npm run dev
pause

