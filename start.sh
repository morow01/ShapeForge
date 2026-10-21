#!/usr/bin/env bash
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
echo "Starting ShapeForge development server at http://localhost:5173/ ... "
npm run dev
