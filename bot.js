#!/usr/bin/env node
/**
 * Meet Recorder Telegram Bot
 * 
 * Silently records Google Meet sessions on a headless VPS.
 * Control via Telegram: /record, /stop, /status, /list, /screenshot
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Recorder = require('./lib/recorder');

// ─── Config ─────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || './recordings');
const GUEST_NAME = process.env.GUEST_NAME || 'Recorder';
const CONFIG = {
  fps: parseInt(process.env.RECORD_FPS) || 30,
  crf: parseInt(process.env.RECORD_CRF) || 23,
  resolution: process.env.RECORD_RESOLUTION || '1280x720',
  maxDuration: parseInt(process.env.MAX_DURATION) || 10800,
  displayNum: parseInt(process.env.DISPLAY_NUM) || 99,
  cdpPort: parseInt(process.env.CDP_PORT) || 9222,
  guestName: GUEST_NAME,
  recordingsDir: RECORDINGS_DIR,
};

if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required in .env');
  process.exit(1);
}

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ─── Bot init ───────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
const recorder = new Recorder(CONFIG);

console.log('🤖 Meet Recorder Bot started!');
console.log(`   Allowed users: ${ALLOWED.length ? ALLOWED.join(', ') : 'ALL (⚠️ set ALLOWED_USERS!)'}`);

// ─── Auth middleware ────────────────────────────────────────────
function isAllowed(msg) {
  if (!ALLOWED.length) return true;
  return ALLOWED.includes(String(msg.from.id));
}

function deny(msg) {
  bot.sendMessage(msg.chat.id, '🚫 Bạn không có quyền sử dụng bot này.');
}

// ─── Commands ───────────────────────────────────────────────────

// /start - Welcome
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  bot.sendMessage(msg.chat.id,
    '🎬 *Meet Recorder Bot*\n\n' +
    'Ghi âm Google Meet tự động trên VPS.\n\n' +
    '📋 *Lệnh:*\n' +
    '`/record <meet-url>` — Bắt đầu ghi\n' +
    '`/stop` — Dừng ghi\n' +
    '`/status` — Trạng thái hiện tại\n' +
    '`/screenshot` — Chụp màn hình\n' +
    '`/list` — Danh sách bản ghi\n' +
    '`/download <filename>` — Tải bản ghi\n' +
    '`/delete <filename>` — Xoá bản ghi\n' +
    '`/disk` — Dung lượng ổ đĩa\n' +
    '`/help` — Trợ giúp',
    { parse_mode: 'Markdown' }
  );
});

// /help
bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  bot.sendMessage(msg.chat.id,
    '📖 *Hướng dẫn sử dụng*\n\n' +
    '1️⃣ Lấy link Meet (vd: `https://meet.google.com/abc-defg-hij`)\n' +
    '2️⃣ Gửi `/record <link>`\n' +
    '3️⃣ Bot sẽ tự join, tắt mic/cam, bắt đầu ghi\n' +
    '4️⃣ Gửi `/stop` khi muốn dừng\n' +
    '5️⃣ Bot gửi file MP4 về Telegram\n\n' +
    '⚙️ *Cài đặt:*\n' +
    `• FPS: ${CONFIG.fps}\n` +
    `• Chất lượng: CRF ${CONFIG.crf}\n` +
    `• Độ phân giải: ${CONFIG.resolution}\n` +
    `• Thời lượng tối đa: ${Math.floor(CONFIG.maxDuration / 3600)}h\n` +
    `• Tên guest: ${CONFIG.guestName}\n\n` +
    '💡 *Tips:*\n' +
    '• Bot join dưới dạng guest, mic/cam tắt hoàn toàn\n' +
    '• Video ghi lại toàn bộ màn hình Meet + âm thanh\n' +
    '• File > 50MB sẽ không gửi được qua Telegram',
    { parse_mode: 'Markdown' }
  );
});

// /record <url> [duration]
bot.onText(/\/record(?:@\w+)?\s+(https?:\/\/meet\.google\.com\/[\w-]+)\s*(\d*)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg);
  const chatId = msg.chat.id;
  const meetUrl = match[1];
  const duration = match[2] ? parseInt(match[2]) : CONFIG.maxDuration;

  if (recorder.isRecording()) {
    return bot.sendMessage(chatId, '⚠️ Đang ghi một phiên khác! Gửi /stop trước.');
  }

  const statusMsg = await bot.sendMessage(chatId,
    `🎬 *Đang chuẩn bị ghi...*\n` +
    `🔗 ${meetUrl}\n` +
    `⏱ Max: ${Math.floor(duration / 60)} phút`,
    { parse_mode: 'Markdown' }
  );

  try {
    // Progress updates
    recorder.on('stage', (stage) => {
      const stages = {
        'xvfb': '🖥 Khởi tạo màn hình ảo...',
        'pulse': '🔊 Khởi tạo audio...',
        'chrome': '🌐 Mở Chrome...',
        'joining': '🚪 Đang vào Meet...',
        'recording': '📹 Đang ghi! Gửi /stop để dừng.',
      };
      bot.editMessageText(
        `🎬 *Ghi Meet*\n🔗 ${meetUrl}\n\n${stages[stage] || stage}`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    const outputPath = await recorder.start(meetUrl, duration);

    // Recording started successfully
    bot.editMessageText(
      `✅ *Đang ghi!*\n🔗 ${meetUrl}\n📹 ${path.basename(outputPath)}\n\n💡 Gửi /stop để dừng`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

    // Wait for recording to end (stop or max duration)
    recorder.once('stopped', async (info) => {
      await bot.sendMessage(chatId,
        `🛑 *Đã dừng ghi!*\n` +
        `📁 File: \`${info.filename}\`\n` +
        `📊 Kích thước: ${info.size}\n` +
        `⏱ Thời lượng: ${info.duration}`,
        { parse_mode: 'Markdown' }
      );

      // Auto-send if < 50MB (Telegram limit)
      if (info.sizeBytes < 50 * 1024 * 1024) {
        await bot.sendMessage(chatId, '📤 Đang gửi file...');
        try {
          await bot.sendVideo(chatId, info.path, {
            caption: `🎬 Meet Recording\n📅 ${info.filename}`,
            supports_streaming: true,
          });
        } catch (e) {
          await bot.sendDocument(chatId, info.path, {
            caption: `🎬 Meet Recording\n📅 ${info.filename}`,
          });
        }
      } else {
        await bot.sendMessage(chatId,
          `⚠️ File quá lớn (${info.size}) - không gửi được qua Telegram.\n` +
          `Dùng /download ${info.filename} nếu cần (sẽ thử chia nhỏ).`
        );
      }
    });

  } catch (err) {
    bot.editMessageText(
      `❌ *Lỗi:* ${err.message}`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

// Catch invalid /record format
bot.onText(/\/record(?:@\w+)?(?:\s|$)(?!https?:\/\/meet\.google\.com)/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  if (msg.text.match(/\/record(?:@\w+)?\s+https?:\/\/meet\.google\.com/)) return;
  bot.sendMessage(msg.chat.id,
    '❌ Sai format! Dùng:\n`/record https://meet.google.com/xxx-xxxx-xxx`',
    { parse_mode: 'Markdown' }
  );
});

// /stop
bot.onText(/\/stop/, async (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  if (!recorder.isRecording()) {
    return bot.sendMessage(msg.chat.id, '⚠️ Không có phiên ghi nào đang chạy.');
  }
  await bot.sendMessage(msg.chat.id, '🛑 Đang dừng ghi...');
  recorder.stop();
});

// /status
bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  const info = recorder.getStatus();
  if (!info.recording) {
    return bot.sendMessage(msg.chat.id, '💤 Không có phiên ghi nào đang chạy.');
  }
  bot.sendMessage(msg.chat.id,
    `📹 *Đang ghi*\n` +
    `🔗 ${info.url}\n` +
    `📁 ${info.filename}\n` +
    `⏱ Đã ghi: ${info.elapsed}\n` +
    `📊 Kích thước: ${info.currentSize}`,
    { parse_mode: 'Markdown' }
  );
});

// /screenshot
bot.onText(/\/screenshot/, async (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  const chatId = msg.chat.id;
  try {
    const imgPath = await recorder.screenshot();
    await bot.sendPhoto(chatId, imgPath, { caption: '📸 Screenshot Meet hiện tại' });
    fs.unlinkSync(imgPath);
  } catch (e) {
    bot.sendMessage(chatId, `❌ ${e.message}`);
  }
});

// /list
bot.onText(/\/list/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.mp4'))
    .sort()
    .reverse();

  if (!files.length) {
    return bot.sendMessage(msg.chat.id, '📂 Chưa có bản ghi nào.');
  }

  const list = files.map(f => {
    const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `📹 \`${f}\` — ${sizeMB}MB`;
  }).join('\n');

  bot.sendMessage(msg.chat.id,
    `📂 *Danh sách bản ghi (${files.length}):*\n\n${list}`,
    { parse_mode: 'Markdown' }
  );
});

// /download <filename>
bot.onText(/\/download(?:@\w+)?\s+(.+\.mp4)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg);
  const chatId = msg.chat.id;
  const filename = match[1].trim();
  const filePath = path.join(RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return bot.sendMessage(chatId, `❌ Không tìm thấy: \`${filename}\``, { parse_mode: 'Markdown' });
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    return bot.sendMessage(chatId, `⚠️ File quá lớn (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB limit).`);
  }

  await bot.sendMessage(chatId, '📤 Đang gửi...');
  try {
    await bot.sendVideo(chatId, filePath, {
      caption: `🎬 ${filename}`,
      supports_streaming: true,
    });
  } catch {
    await bot.sendDocument(chatId, filePath, { caption: `🎬 ${filename}` });
  }
});

// /delete <filename>
bot.onText(/\/delete(?:@\w+)?\s+(.+\.mp4)/, (msg, match) => {
  if (!isAllowed(msg)) return deny(msg);
  const filename = match[1].trim();
  const filePath = path.join(RECORDINGS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return bot.sendMessage(msg.chat.id, `❌ Không tìm thấy: \`${filename}\``, { parse_mode: 'Markdown' });
  }

  const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  fs.unlinkSync(filePath);
  bot.sendMessage(msg.chat.id, `🗑 Đã xoá: \`${filename}\` (${sizeMB}MB)`, { parse_mode: 'Markdown' });
});

// /disk
bot.onText(/\/disk/, (msg) => {
  if (!isAllowed(msg)) return deny(msg);
  try {
    const df = execSync('df -h / | tail -1').toString().trim().split(/\s+/);
    const du = execSync(`du -sh ${RECORDINGS_DIR}`).toString().trim().split('\t')[0];
    bot.sendMessage(msg.chat.id,
      `💾 *Dung lượng*\n` +
      `• Tổng: ${df[1]}\n` +
      `• Đã dùng: ${df[2]} (${df[4]})\n` +
      `• Còn trống: ${df[3]}\n` +
      `• Recordings: ${du}`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    bot.sendMessage(msg.chat.id, '❌ Không kiểm tra được dung lượng.');
  }
});

// ─── Error handling ─────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

bot.on('polling_error', (err) => {
  console.error('Telegram polling error:', err.message);
});

console.log('✅ Bot ready! Waiting for commands...');
