@echo off
title ShapeForge Dev Server
cd /d "%~dp0"
echo Starting ShapeForge development server at http://127.0.0.1:5173/ ...
npm run dev -- --host 127.0.0.1
pause
