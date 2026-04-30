#!/usr/bin/env bash
# Build single-file .exe for FinFin client (run in Git Bash / WSL with Python installed)

set -e
cd "$(dirname "$0")"

python -m pip install --upgrade pip
python -m pip install -r requirements.txt

python -m PyInstaller \
  --noconfirm \
  --onefile \
  --windowed \
  --name FinFin \
  --hidden-import customtkinter \
  main.py

echo
echo "Build complete → dist/FinFin.exe"
