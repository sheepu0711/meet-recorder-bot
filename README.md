# 🎬 Meet Recorder Bot

> Telegram bot tự động ghi âm Google Meet trên VPS — hoàn toàn headless, stealth mode.

![Node.js](https://img.shields.io/badge/Node.js-20+-green)
![License](https://img.shields.io/badge/License-MIT-blue)
![Platform](https://img.shields.io/badge/Platform-Ubuntu%2022.04+-orange)

## ✨ Tính năng

- 🤖 **Điều khiển qua Telegram** — Gửi link Meet, bot tự ghi
- 🔇 **Stealth mode** — Mic/cam tắt hoàn toàn, không ai biết đang ghi
- 📹 **720p 30fps** — Video mượt, file nhẹ
- 📤 **Tự gửi file** về Telegram khi dừng ghi
- 📸 **Screenshot** — Xem đang ghi gì real-time
- 🔒 **Whitelist** — Chỉ user được phép mới dùng được
- ⏱ **Tự dừng** — Tối đa 3 tiếng (tùy chỉnh)
- 🐳 **Docker support** — Deploy dễ dàng

## 📋 Yêu cầu hệ thống

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS | Ubuntu 22.04+ (amd64) | Ubuntu 24.04 |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 5 GB trống | 20 GB trống |
| Node.js | 18+ | 20 LTS |

> ⚠️ **Lưu ý**: 2 vCPU chỉ đạt ~15-20fps thực tế. 4 vCPU mới đạt 30fps mượt.

## 🚀 Cài đặt

### Cách 1: Script tự động (khuyến nghị)

```bash
git clone https://github.com/sheepu0711/meet-recorder-bot.git
cd meet-recorder-bot
sudo bash scripts/setup.sh
```

Script sẽ tự cài: Xvfb, PulseAudio, FFmpeg, Chrome, Node.js, PM2.

### Cách 2: Cài thủ công

```bash
# 1. Cài system packages
sudo apt update
sudo apt install -y xvfb pulseaudio ffmpeg imagemagick

# 2. Cài Google Chrome
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i /tmp/chrome.deb
sudo apt -f install -y

# 3. Clone & cài npm
git clone https://github.com/sheepu0711/meet-recorder-bot.git
cd meet-recorder-bot
npm install --production
```

### Cách 3: Docker

```bash
git clone https://github.com/sheepu0711/meet-recorder-bot.git
cd meet-recorder-bot
cp .env.example .env
# Chỉnh .env (xem phần Cấu hình)
docker build -t meet-recorder .
docker run -d --name meet-recorder --env-file .env meet-recorder
```

## ⚙️ Cấu hình

### 1. Tạo Telegram Bot

1. Mở Telegram, tìm **@BotFather**
2. Gửi `/newbot`
3. Đặt tên bot (ví dụ: `My Meet Recorder`)
4. Đặt username (ví dụ: `my_meet_recorder_bot`)
5. Copy **token** BotFather gửi

### 2. Lấy Telegram User ID

1. Mở Telegram, tìm **@userinfobot**
2. Gửi `/start`
3. Copy **Id** (số)

### 3. Chỉnh file `.env`

```bash
cp .env.example .env
nano .env
```

```env
# Telegram Bot Token (BẮT BUỘC)
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# User IDs được phép dùng bot (BẮT BUỘC)
# Nhiều user: cách nhau bằng dấu phẩy
ALLOWED_USERS=123456789

# Tên hiển thị khi join Meet
GUEST_NAME=Recorder

# Recording settings
RECORD_FPS=30          # 15-30 tuỳ CPU
RECORD_CRF=23          # 18(đẹp/nặng) - 28(nhẹ/mờ)
RECORD_RESOLUTION=1280x720
MAX_DURATION=10800     # 3 giờ (seconds)
```

### 4. Đăng nhập Google (để vào Meet cần đăng nhập)

Mặc định bot vào Meet dưới dạng **khách** — chỉ vào được Meet công khai cho phép khách.
Để vào các Meet **yêu cầu đăng nhập**, cho bot dùng một tài khoản Google
(**nên dùng tài khoản phụ, tạo riêng cho bot, KHÔNG bật 2FA**).

Cơ chế **hybrid**: bot dùng một *profile Chrome cố định* để nhớ phiên đăng nhập.
Ưu tiên session đã lưu; nếu chưa đăng nhập và có sẵn credentials thì tự đăng nhập.

**Cách A — đăng nhập 1 lần (an toàn nhất, không lưu mật khẩu):**

```bash
# (tuỳ chọn) điền GOOGLE_EMAIL/PASSWORD vào .env để tự động, rồi:
npm run login
```

`npm run login` mở Chrome với profile cố định, đăng nhập, lưu cookie lại. Chạy **một lần**.
Ảnh màn hình kết quả lưu ở `recordings/login_*.png` (xem để biết Google có hỏi gì).

> Nếu KHÔNG điền credentials, `npm run login` sẽ giữ Chrome sống 10 phút và in
> hướng dẫn để bạn tự đăng nhập bằng tay. Cách ổn định nhất là **VNC vào màn hình ảo**:
> ```bash
> # trên VPS
> apt-get install -y x11vnc && x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever -bg
> # trên máy bạn
> ssh -L 5900:localhost:5900 root@<IP-VPS>   # rồi mở VNC viewer tới localhost:5900
> ```
> (chrome://inspect qua `ssh -L 9222:localhost:9222` cũng được, nhưng KHÔNG mở
> thẳng `http://localhost:9222` — phải vào `chrome://inspect` → thêm `localhost:9222`.)

**Cách B — tự đăng nhập mỗi khi cần:** chỉ cần điền trong `.env`:

```env
GOOGLE_EMAIL=botaccount@gmail.com
GOOGLE_PASSWORD=app-or-account-password
```

> ⚠️ Đăng nhập tự động kiểu headless hay bị Google chặn/khoá nếu bật 2FA hoặc
> dùng tài khoản chính. Nếu thất bại bot **tự fallback về join khách**.
> Khuyến nghị: tài khoản phụ + `npm run login` một lần.

## 🎮 Sử dụng

### Chạy bot

```bash
# Foreground (dev/test)
npm start

# Background với PM2 (production)
npm run pm2

# Xem logs
npm run pm2:logs

# Dừng bot
npm run pm2:stop
```

### Lệnh Telegram

| Lệnh | Mô tả |
|-------|--------|
| `/start` | Xem menu lệnh |
| `/record <meet-url>` | Bắt đầu ghi Meet |
| `/stop` | Dừng ghi |
| `/status` | Xem trạng thái đang ghi |
| `/screenshot` | Chụp màn hình hiện tại |
| `/list` | Danh sách các bản ghi |
| `/download <file>` | Tải bản ghi về Telegram |
| `/delete <file>` | Xoá bản ghi |
| `/disk` | Xem dung lượng ổ đĩa |
| `/help` | Hướng dẫn chi tiết |

### Ví dụ sử dụng

```
Bạn: /record https://meet.google.com/abc-defg-hij
Bot: 🎬 Đang chuẩn bị ghi...
Bot: 🖥 Khởi tạo màn hình ảo...
Bot: 🌐 Mở Chrome...
Bot: 🚪 Đang vào Meet...
Bot: ✅ Đang ghi! Gửi /stop để dừng.

(30 phút sau)

Bạn: /stop
Bot: 🛑 Đã dừng ghi!
     📁 File: meet_20260305_143022.mp4
     📊 Kích thước: 12.4MB
     ⏱ Thời lượng: 30m 15s
Bot: 📤 Đang gửi file...
Bot: 🎬 [video file]
```

## 🏗 Kiến trúc

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Telegram    │────▶│   bot.js     │────▶│  Recorder   │
│  User        │◀────│  (commands)  │◀────│  Engine     │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                    ┌───────────────────────────┘
                    ▼
        ┌─────────────────────┐
        │     Xvfb :99        │  Virtual display 1280x720
        │  ┌───────────────┐  │
        │  │ Google Chrome  │  │  Headless, fake mic/cam
        │  │ (Meet session) │  │  CDP automation (port 9222)
        │  └───────┬───────┘  │
        └──────────┼──────────┘
                   │
          ┌────────┴────────┐
          ▼                 ▼
    ┌──────────┐     ┌──────────────┐
    │  FFmpeg   │     │  PulseAudio  │
    │ x11grab   │     │  null-sink   │
    │  capture  │◀────│  (audio)     │
    └────┬─────┘     └──────────────┘
         │
         ▼
    ┌──────────┐
    │  .mp4    │  720p 30fps, H.264 + AAC
    │  file    │
    └──────────┘
```

### Cách hoạt động

1. **Xvfb** tạo màn hình ảo 1280x720 (display `:99`)
2. **Chrome** mở Google Meet với fake mic (file im lặng) + fake cam (khung đen)
3. **CDP** (Chrome DevTools Protocol) tự động:
   - Tắt popup "Got it"
   - Tắt mic/cam trên giao diện pre-join
   - Nhập tên guest
   - Click "Join now"
   - Double-check mic/cam sau khi join
4. **PulseAudio** tạo virtual sink bắt audio output từ Chrome
5. **FFmpeg** ghi màn hình (x11grab) + audio (pulse) → MP4

## 📁 Cấu trúc thư mục

```
meet-recorder-bot/
├── bot.js                 # Telegram bot (entry point)
├── lib/
│   └── recorder.js        # Recording engine
├── scripts/
│   └── setup.sh           # Auto-setup script
├── recordings/            # Output directory (git-ignored)
├── logs/                  # PM2 logs (git-ignored)
├── .env.example           # Template config
├── .env                   # Your config (git-ignored)
├── ecosystem.config.js    # PM2 config
├── Dockerfile             # Docker support
├── package.json
└── README.md
```

## 🔧 Tuỳ chỉnh

### Thay đổi chất lượng video

Trong `.env`:

```env
# Mượt hơn (cần nhiều CPU hơn)
RECORD_FPS=30

# Nhẹ file hơn (chất lượng giảm nhẹ)
RECORD_CRF=28

# Đẹp hơn (file nặng hơn)
RECORD_CRF=18
```

### Thêm nhiều user

```env
ALLOWED_USERS=123456789,987654321,111222333
```

### Thay đổi tên guest

```env
GUEST_NAME=ClassBot
```

### Ghi dài hơn

```env
# 6 tiếng
MAX_DURATION=21600
```

## ❓ Troubleshooting

### Bot không join được Meet

- **Meet yêu cầu đăng nhập**: join khách chỉ vào được Meet công khai. Cấu hình
  tài khoản Google (xem *Cấu hình → Đăng nhập Google*) rồi chạy `npm run login`.
- **"Ask to join"**: Host phải duyệt. Bot đợi ở lobby và **vẫn bắt đầu ghi** —
  ghi lại đúng thời điểm được cho vào.
- **Bấm nút Join không vào / điện thoại thì vào được**: thường do Chrome bị Google
  nhận diện là bot. Bản này đã dùng `puppeteer-extra-plugin-stealth` + click chuột
  thật để khắc phục. Nếu vẫn lỗi, gửi `/screenshot` để xem Chrome đang hiện gì.
- **Chrome crash giữa chừng**: bot sẽ báo "bị gián đoạn", lưu phần đã ghi và gửi file.
  Kiểm tra `logs/error.log` và RAM (`free -h`); cần ≥ 2GB RAM cho Chrome + FFmpeg.
- **Đăng nhập Google thất bại**: dùng tài khoản phụ KHÔNG bật 2FA; xem ảnh
  `recordings/login_*.png` để biết Google đang chặn/hỏi gì.

### Video bị đen / không có nội dung

- Chrome có thể chưa render kịp. Tăng sleep time trong `lib/recorder.js` (dòng `await this._sleep(8000)`)
- Kiểm tra Xvfb: `DISPLAY=:99 xdpyinfo` phải trả về thông tin display

### Audio bị lỗi / không có

- Kiểm tra PulseAudio: `pactl list short sinks` phải có `virtual_speaker`
- Restart PulseAudio: `pulseaudio -k && pulseaudio --start`

### File quá lớn để gửi qua Telegram

- Telegram giới hạn 50MB cho bot
- Giảm `RECORD_CRF` (tăng số = nhẹ hơn, vd: 28)
- Giảm `RECORD_FPS` (vd: 15)

### CPU quá tải khi ghi

- Giảm FPS: `RECORD_FPS=15`
- Dùng VPS mạnh hơn (4 vCPU recommended)
- Kiểm tra: `htop` trong khi ghi

## 📄 License

MIT — Tự do sử dụng, chỉnh sửa, phân phối.

## 👨‍💻 Author

**sheepu0711** — Made with 🐑 and ☕
