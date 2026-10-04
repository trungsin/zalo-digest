#!/usr/bin/env bash
# One-time VPS setup (Ubuntu/Debian): Node.js 22, pm2, cloudflared, the app itself.
# Run as the normal user (needs sudo):  bash setup-vps.sh
# Safe to re-run: it skips what's installed and pulls the latest code.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/zalo-digest}"
REPO="${REPO:-https://github.com/trungsin/zalo-digest}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Gói hệ thống"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates

step "Node.js 22"
if ! command -v node >/dev/null || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

step "pm2"
command -v pm2 >/dev/null || sudo npm install -g pm2
# Restart the apps after a reboot.
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null

step "cloudflared"
if ! command -v cloudflared >/dev/null; then
  arch="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  sudo dpkg -i /tmp/cloudflared.deb
fi
cloudflared --version

step "Mã nguồn ($APP_DIR)"
# Private repo: git asks for your GitHub username and a Personal Access Token (not your password).
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci
mkdir -p users && chmod 700 users

step "Xong"
cat <<EOF
Tiếp theo (xem README, phần "Triển khai lên VPS với Cloudflare Tunnel"):
  1. cd $APP_DIR && npm run add-user -- <tên>
  2. Sửa users/<tên>/.env (GEMINI_API_KEY, MCP_TOKEN, MCP_PORT)
  3. USER_DIR=users/<tên> npm run groups   → quét QR, chép ID nhóm vào .env
  4. pm2 start ecosystem.config.cjs --only zalo-<tên> && pm2 save
  5. sudo cloudflared service install <TUNNEL_TOKEN>
EOF
