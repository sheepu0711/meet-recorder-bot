#!/bin/bash
# ============================================
# Meet Recorder Bot — Auto Setup Script
# Tested on: Ubuntu 22.04 / 24.04 (amd64)
# ============================================

set -e

echo "🚀 Meet Recorder Bot — Setup"
echo "=============================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

# Check root
[ "$(id -u)" -eq 0 ] || fail "Chạy bằng root! (sudo bash scripts/setup.sh)"

echo ""
echo "📦 [1/6] Cập nhật apt & cài dependencies..."
apt-get update -qq
apt-get install -y -qq \
  xvfb \
  pulseaudio \
  ffmpeg \
  imagemagick \
  curl \
  wget \
  gnupg \
  > /dev/null 2>&1
ok "System packages"

echo ""
echo "🌐 [2/6] Cài Google Chrome..."
if command -v google-chrome &>/dev/null; then
  CHROME_VER=$(google-chrome --version 2>/dev/null | awk '{print $3}')
  ok "Chrome đã có (v${CHROME_VER})"
else
  wget -q -O /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  apt-get install -y -qq /tmp/chrome.deb > /dev/null 2>&1 || {
    apt-get -f install -y -qq > /dev/null 2>&1
  }
  rm -f /tmp/chrome.deb
  if command -v google-chrome &>/dev/null; then
    ok "Chrome installed ($(google-chrome --version 2>/dev/null | awk '{print $3}'))"
  else
    fail "Không cài được Chrome!"
  fi
fi

echo ""
echo "📗 [3/6] Kiểm tra Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  ok "Node.js ${NODE_VER}"
else
  echo "   Cài Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  ok "Node.js $(node --version)"
fi

echo ""
echo "📦 [4/6] Cài npm dependencies..."
cd "$(dirname "$0")/.."
npm install --production > /dev/null 2>&1
ok "npm packages installed"

echo ""
echo "⚙️  [5/6] Cấu hình..."
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env đã tạo từ .env.example — CẦN CHỈNH SỬA!"
  echo ""
  echo "   👉 Mở file .env và điền:"
  echo "      TELEGRAM_BOT_TOKEN=<token từ @BotFather>"
  echo "      ALLOWED_USERS=<Telegram user ID của bạn>"
  echo ""
else
  ok ".env đã tồn tại"
fi

echo ""
echo "🔧 [6/6] Cài PM2 (nếu chưa có)..."
if command -v pm2 &>/dev/null; then
  ok "PM2 $(pm2 --version 2>/dev/null)"
else
  npm install -g pm2 > /dev/null 2>&1
  ok "PM2 installed"
fi

echo ""
echo "=============================="
echo -e "${GREEN}🎉 Setup hoàn tất!${NC}"
echo ""
echo "📋 Bước tiếp theo:"
echo "   1. Chỉnh .env (TELEGRAM_BOT_TOKEN + ALLOWED_USERS)"
echo "   2. Chạy: npm start       (foreground)"
echo "      hoặc: npm run pm2     (background với PM2)"
echo "   3. Gửi /start cho bot trên Telegram"
echo "   4. Gửi /record https://meet.google.com/xxx-xxxx-xxx"
echo ""
