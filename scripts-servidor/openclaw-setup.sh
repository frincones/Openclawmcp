#!/bin/bash
set -e

echo "=== 1. System update ==="
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

echo "=== 2. Install Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y -qq nodejs

echo "=== 3. Install Chrome dependencies ==="
sudo apt-get install -y -qq wget gnupg ca-certificates fonts-liberation \
  libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
  libcups2t64 libdbus-1-3 libdrm2 libgbm1 \
  libgtk-3-0t64 libnspr4 libnss3 libx11-xcb1 \
  libxcomposite1 libxdamage1 libxrandr2 \
  xdg-utils python3 python3-pip git unzip

echo "=== 4. Install Chromium (ARM native) ==="
sudo apt-get install -y -qq chromium-browser 2>/dev/null || sudo snap install chromium 2>/dev/null || echo "Chromium needs manual install"

echo "=== 5. Install OpenClaw ==="
sudo npm install -g openclaw

echo "=== 6. Create swap (Chrome needs extra memory) ==="
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

echo "=== 7. Install playwright-core ==="
sudo npm install -g playwright-core

echo "=== VERSIONS ==="
node --version
npm --version
openclaw --version
chromium-browser --version 2>/dev/null || echo "chromium via snap"
free -h

echo "=== SETUP COMPLETE ==="
