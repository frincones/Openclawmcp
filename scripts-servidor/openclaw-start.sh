#!/bin/bash
set -e

echo "=== 1. Clean old sessions ==="
# Remove bloated session files to start fresh
rm -f /home/ubuntu/.openclaw/agents/main/sessions/*.jsonl
rm -f /home/ubuntu/.openclaw/agents/main/sessions/*.lock
# Reset sessions.json to empty
echo '{}' > /home/ubuntu/.openclaw/agents/main/sessions/sessions.json
echo "Sessions cleaned"

echo "=== 2. Install npm deps for workspace ==="
cd /home/ubuntu/.openclaw
npm install playwright-core 2>/dev/null || true
cd /home/ubuntu/.openclaw/workspace/linkedin-automation
npm install 2>/dev/null || true
pip3 install --break-system-packages playwright 2>/dev/null || true

echo "=== 3. Create systemd service ==="
sudo tee /etc/systemd/system/openclaw.service > /dev/null << 'EOF'
[Unit]
Description=OpenClaw AI Agent Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
Environment=HOME=/home/ubuntu
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/snap/bin
ExecStart=/usr/bin/openclaw gateway
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "=== 4. Enable and start service ==="
sudo systemctl daemon-reload
sudo systemctl enable openclaw
sudo systemctl start openclaw
sleep 5
sudo systemctl status openclaw --no-pager

echo "=== 5. Check gateway ==="
sleep 10
openclaw health || echo "Gateway starting up..."

echo "=== DONE ==="
