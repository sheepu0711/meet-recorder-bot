#!/usr/bin/env node
/**
 * One-time Google login helper.
 *
 *   npm run login
 *
 * Signs the persistent Chrome profile into a Google account so the bot can join
 * Meets that require sign-in. Run it ONCE; the session is reused afterwards.
 *
 * - If GOOGLE_EMAIL / GOOGLE_PASSWORD are set in .env → automated login.
 * - Otherwise it prints how to log in manually over an SSH tunnel.
 *
 * Use a DEDICATED Google account with 2-Step Verification OFF for automated login.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { launchBrowser, defaultProfileDir } = require('../lib/browser');
const { isSignedIn, googleLogin } = require('../lib/google-auth');

const DISPLAY_NUM = parseInt(process.env.DISPLAY_NUM) || 99;
const RES = process.env.RECORD_RESOLUTION || '1280x720';
const [W, H] = RES.split('x').map(Number);
const EMAIL = process.env.GOOGLE_EMAIL || '';
const PASSWORD = process.env.GOOGLE_PASSWORD || '';
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || './recordings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureXvfb() {
  try {
    execSync(`pgrep -f "Xvfb :${DISPLAY_NUM}"`, { stdio: 'pipe' });
    return;
  } catch {}
  console.log(`🖥  Khởi tạo Xvfb :${DISPLAY_NUM} ...`);
  const xvfb = spawn('Xvfb', [
    `:${DISPLAY_NUM}`, '-screen', '0', `${W}x${H}x24`,
    '-ac', '+extension', 'GLX', '+render', '-noreset',
  ], { detached: true, stdio: 'ignore' });
  xvfb.unref();
}

function snapshot(name) {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    const out = path.join(RECORDINGS_DIR, name);
    execSync(`DISPLAY=:${DISPLAY_NUM} import -window root "${out}"`, {
      timeout: 10000, env: { ...process.env, DISPLAY: `:${DISPLAY_NUM}` },
    });
    console.log(`📸 Ảnh màn hình: ${out}`);
  } catch {}
}

(async () => {
  console.log('🔑 Google login helper');
  console.log(`   Profile: ${defaultProfileDir(process.env.CHROME_PROFILE_DIR)}`);

  try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
  ensureXvfb();
  await sleep(2000);

  const { browser, page } = await launchBrowser({
    chromePath: process.env.CHROME_PATH || '',
    displayNum: DISPLAY_NUM,
    width: W,
    height: H,
    // Bound to localhost; enables the documented manual-login SSH tunnel
    // (ssh -L 9222:localhost:9222 ... then open http://localhost:9222).
    extraArgs: ['--remote-debugging-port=9222'],
  });

  try {
    if (await isSignedIn(page)) {
      console.log('✅ Profile đã đăng nhập Google sẵn rồi. Không cần làm gì.');
      snapshot('login_already.png');
      return;
    }

    if (EMAIL && PASSWORD) {
      const ok = await googleLogin(page, EMAIL, PASSWORD, (m) => console.log('  ', m));
      await sleep(1500);
      if (ok && await isSignedIn(page)) {
        console.log('✅ Đăng nhập thành công! Session đã được lưu vào profile.');
        snapshot('login_success.png');
      } else {
        console.log('❌ Đăng nhập KHÔNG xác nhận được.');
        console.log('   Nguyên nhân thường gặp: bật 2FA, Google chặn login lạ, sai mật khẩu,');
        console.log('   hoặc cần xác minh thiết bị. Xem ảnh để biết Google đang yêu cầu gì:');
        snapshot('login_failed.png');
      }
    } else {
      console.log('\n⚠️  Chưa cấu hình GOOGLE_EMAIL / GOOGLE_PASSWORD trong .env.');
      console.log('   Cách 1 (khuyến nghị): thêm 2 dòng đó vào .env rồi chạy lại `npm run login`.');
      console.log('   Cách 2 (đăng nhập thủ công qua SSH tunnel):');
      console.log('     1) Trên máy bạn:  ssh -L 9222:localhost:9222 user@vps');
      console.log('     2) Mở http://localhost:9222 → bấm vào tab → đăng nhập Google bằng tay.');
      console.log('   Đang mở trang đăng nhập Google và đợi tối đa 5 phút...');
      await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        snapshot('login_manual.png');
        if (await isSignedIn(page)) {
          console.log('✅ Đã phát hiện đăng nhập! Session đã lưu.');
          snapshot('login_success.png');
          break;
        }
        await sleep(15000);
      }
    }
  } finally {
    await sleep(1500);
    await browser.close().catch(() => {});
    console.log('👋 Xong.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(1);
});
