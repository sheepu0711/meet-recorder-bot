/**
 * Meet Recorder Engine
 *
 * Pipeline: Xvfb → Chrome (puppeteer-extra + stealth) → PulseAudio → FFmpeg
 *
 * Chrome is driven with puppeteer + the stealth plugin (not raw CDP) so that:
 *   - clicks are REAL trusted pointer events (Meet ignores untrusted JS clicks),
 *   - we wait for elements instead of fixed sleeps (fixes flaky joins),
 *   - the browser is not flagged as a bot (a phone can join, headless often can't),
 *   - a persistent profile keeps the Google login (lets it join non-public Meets).
 */

const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { launchBrowser, defaultProfileDir } = require('./browser');
const { ensureLoggedIn } = require('./google-auth');

// Text used to find buttons across English / Vietnamese Meet UIs.
const JOIN_KEYS = ['join now', 'ask to join', 'tham gia ngay', 'yêu cầu tham gia', 'join', 'tham gia'];
const MIC_OFF_KEYS = ['turn off microphone', 'tắt micrô', 'tắt micro'];
const CAM_OFF_KEYS = ['turn off camera', 'tắt máy ảnh', 'tắt camera'];
const POPUP_KEYS = ['got it', 'dismiss', 'no thanks', 'đã hiểu', 'bỏ qua',
  'continue without microphone', 'continue without camera', 'tiếp tục mà không'];

class Recorder extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this._browser = null;
    this._page = null;
    this._ffmpegProcess = null;
    this._stopping = false;
    this.state = {
      recording: false,
      url: null,
      outputPath: null,
      startTime: null,
      ffmpegPid: null,
      chromePid: null,
    };
  }

  isRecording() {
    return this.state.recording;
  }

  getStatus() {
    if (!this.state.recording) return { recording: false };
    const elapsed = Date.now() - this.state.startTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    let currentSize = '0B';
    try {
      const stat = fs.statSync(this.state.outputPath);
      currentSize = this._formatSize(stat.size);
    } catch {}

    return {
      recording: true,
      url: this.state.url,
      filename: path.basename(this.state.outputPath),
      elapsed: `${mins}m ${secs}s`,
      currentSize,
    };
  }

  async start(meetUrl, duration) {
    if (this.state.recording) throw new Error('Đang ghi phiên khác!');

    const { displayNum, resolution, fps, crf, guestName, recordingsDir } = this.config;
    const [width, height] = resolution.split('x').map(Number);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const outputPath = path.join(recordingsDir, `meet_${timestamp}.mp4`);

    this._stopping = false;
    this._ffmpegProcess = null;
    this.state = {
      recording: true,
      url: meetUrl,
      outputPath,
      startTime: Date.now(),
      ffmpegPid: null,
      chromePid: null,
    };

    try {
      // 1. Xvfb
      this.emit('stage', 'xvfb');
      await this._ensureXvfb(displayNum, width, height);

      // 2. PulseAudio
      this.emit('stage', 'pulse');
      await this._ensurePulse();

      // 3. Silent fake mic/cam media
      this._createFakeMedia();

      // 4. Chrome (stealth, persistent profile)
      this.emit('stage', 'chrome');
      await this._launchBrowser(displayNum, width, height);

      // 5. Google login (hybrid) — no-op in guest mode
      await ensureLoggedIn(
        this._page,
        { email: this.config.googleEmail, password: this.config.googlePassword },
        (m) => { this.emit('stage', 'login'); console.log('[login]', m); }
      );

      // 6. Open Meet & join
      this.emit('stage', 'joining');
      await this._openMeet(meetUrl);
      await this._joinMeet(this._page, guestName);

      // 7. FFmpeg
      this.emit('stage', 'recording');
      await this._startFFmpeg(displayNum, resolution, fps, crf, duration, outputPath);

      return outputPath;
    } catch (err) {
      await this._cleanup();
      throw err;
    }
  }

  stop() {
    if (!this.state.recording) return;
    this._stopRecording();
  }

  async screenshot() {
    const displayNum = this.config.displayNum;
    const imgPath = `/tmp/meet_screenshot_${Date.now()}.jpg`;

    try {
      execSync(`pgrep -f "Xvfb :${displayNum}"`, { stdio: 'pipe' });
    } catch {
      throw new Error('Xvfb chưa chạy. Bắt đầu ghi trước!');
    }

    execSync(
      `DISPLAY=:${displayNum} import -window root ${imgPath}`,
      { timeout: 10000, env: { ...process.env, DISPLAY: `:${displayNum}` } }
    );

    if (!fs.existsSync(imgPath)) throw new Error('Không chụp được screenshot.');
    return imgPath;
  }

  // ── Private methods ─────────────────────────────────────────

  async _ensureXvfb(displayNum, width, height) {
    try {
      execSync(`pgrep -f "Xvfb :${displayNum}"`, { stdio: 'pipe' });
      return; // already running
    } catch {}

    const xvfb = spawn('Xvfb', [
      `:${displayNum}`,
      '-screen', '0', `${width}x${height}x24`,
      '-ac', '+extension', 'GLX', '+render', '-noreset',
    ], { detached: true, stdio: 'ignore' });
    xvfb.unref();
    await this._sleep(2000);

    try {
      execSync(`pgrep -f "Xvfb :${displayNum}"`, { stdio: 'pipe' });
    } catch {
      throw new Error('Không khởi tạo được Xvfb!');
    }
  }

  async _ensurePulse() {
    try {
      execSync('pulseaudio --check', { stdio: 'pipe' });
    } catch {
      execSync('pulseaudio --start --exit-idle-time=-1 2>/dev/null || true');
    }

    try {
      const sinks = execSync('pactl list short sinks').toString();
      if (!sinks.includes('virtual_speaker')) {
        execSync('pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description="VirtualSpeaker"');
      }
    } catch {
      execSync('pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description="VirtualSpeaker" 2>/dev/null || true');
    }

    execSync('pactl set-default-sink virtual_speaker 2>/dev/null || true');
    execSync('pactl set-default-source virtual_speaker.monitor 2>/dev/null || true');
  }

  _createFakeMedia() {
    if (!fs.existsSync('/tmp/silence.wav')) {
      execSync('ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 10 /tmp/silence.wav 2>/dev/null');
    }
    if (!fs.existsSync('/tmp/black.mjpeg')) {
      execSync('ffmpeg -y -f lavfi -i color=c=black:s=320x240:r=1 -frames:v 1 /tmp/black.mjpeg 2>/dev/null');
    }
  }

  async _launchBrowser(displayNum, width, height) {
    // Kill any stale Chrome from a previous run (frees the profile lock).
    try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
    await this._sleep(1000);

    const { browser, page } = await launchBrowser({
      profileDir: this.config.chromeProfileDir,
      chromePath: this.config.chromePath,
      displayNum,
      width,
      height,
    });
    this._browser = browser;
    this._page = page;
    this.state.chromePid = (browser.process() && browser.process().pid) || null;

    browser.on('disconnected', () => {
      this._browser = null;
      this._page = null;
      // Chrome died/was killed mid-recording (crash, OOM, profile lock). Don't
      // keep silently capturing a frozen display for hours — finalize what we
      // have and tell the user.
      if (this.state.recording && !this._stopping) {
        this.emit('interrupted', { reason: 'Chrome bị đóng/treo bất ngờ.' });
        this._stopRecording();
      }
    });
  }

  async _openMeet(url) {
    const page = this._page;
    // Meet keeps long-lived connections open, so 'networkidle' never settles —
    // wait for DOM only, then let the join helper wait for actual controls.
    // Don't force a viewport: defaultViewport:null lets the page fill the
    // window so FFmpeg x11grab captures the full frame.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await this._sleep(2500);
  }

  /**
   * Find a clickable element by accessible-name / text keywords.
   * `keys` are tried in PRIORITY order (earlier = more specific), so e.g.
   * "join now" wins over the bare "join" fallback and we don't mis-click.
   */
  async _findByText(page, keys, { onlyAriaLabel = false } = {}) {
    const handle = await page.evaluateHandle((kw, ariaOnly) => {
      const norm = (t) => (t || '').trim().toLowerCase();
      const nodes = [...document.querySelectorAll('button, [role="button"], [aria-label]')];
      const pick = (getText) => {
        for (const k of kw) {            // priority: first key first
          for (const el of nodes) {      // prefer an exact match…
            if (norm(getText(el)) === k) return el;
          }
          for (const el of nodes) {      // …then a substring match
            const t = norm(getText(el));
            if (t && t.includes(k)) return el;
          }
        }
        return null;
      };
      // 1) aria-label (most stable across Meet's obfuscated markup)
      let el = pick((e) => e.getAttribute && e.getAttribute('aria-label'));
      if (el || ariaOnly) return el;
      // 2) visible text
      el = pick((e) => e.textContent);
      if (el) return el;
      // 3) text inside a span/div wrapped by a button
      for (const k of kw) {
        for (const s of document.querySelectorAll('button span, button div, [role="button"] span')) {
          const t = norm(s.textContent);
          if (t && (t === k || t.includes(k))) {
            const b = s.closest('button, [role="button"]');
            if (b) return b;
          }
        }
      }
      return null;
    }, keys, onlyAriaLabel);
    const el = handle.asElement();
    if (el) return el;
    await handle.dispose();
    return null;
  }

  /** Trusted click with a JS-click fallback. */
  async _click(el) {
    if (!el) return false;
    try { await el.evaluate((b) => b.scrollIntoView({ block: 'center', inline: 'center' })); } catch {}
    try {
      await el.click({ delay: 60 });
      return true;
    } catch {
      try { await el.evaluate((b) => b.click()); return true; } catch { return false; }
    }
  }

  async _dismissPopups(page) {
    for (let i = 0; i < 3; i++) {
      const el = await this._findByText(page, POPUP_KEYS);
      if (!el) break;
      await this._click(el);
      await el.dispose();
      await this._sleep(700);
    }
  }

  async _setMicCamOff(page) {
    // The label is only "turn off …" while the device is ON, so matching it
    // guarantees we never accidentally re-enable a device.
    for (const keys of [MIC_OFF_KEYS, CAM_OFF_KEYS]) {
      const el = await this._findByText(page, keys, { onlyAriaLabel: true });
      if (el) {
        await this._click(el);
        await el.dispose();
        await this._sleep(400);
      }
    }
  }

  async _enterGuestName(page, guestName) {
    // When signed in, Meet uses the account name and shows no input — skip.
    const handle = await page.evaluateHandle(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      const inputs = [...document.querySelectorAll('input')].filter((i) => {
        const type = (i.type || 'text').toLowerCase();
        return (type === 'text' || type === '') && !i.disabled && !i.readOnly && visible(i);
      });
      const byName = inputs.find((i) => {
        const l = `${i.getAttribute('aria-label') || ''} ${i.placeholder || ''}`.toLowerCase();
        return l.includes('name') || l.includes('tên');
      });
      if (byName) return byName;
      // Only fall back to a lone text box (the name field); never guess among
      // several inputs (could clobber a search/chat field).
      return inputs.length === 1 ? inputs[0] : null;
    });
    const el = handle.asElement();
    if (el) {
      try {
        await el.click({ clickCount: 3 });
        await el.type(guestName, { delay: 50 });
      } catch {}
      await el.dispose();
    } else {
      await handle.dispose();
    }
  }

  /** True once we are in the call (or waiting in the lobby for admission). */
  async _isInCallOrLobby(page) {
    return page.evaluate(() => {
      const labelHit = (kw) => [...document.querySelectorAll('[aria-label]')].some((e) => {
        const l = (e.getAttribute('aria-label') || '').toLowerCase();
        return kw.some((k) => l.includes(k));
      });
      // Definitely in the call:
      if (labelHit(['leave call', 'rời khỏi cuộc gọi', 'rời cuộc gọi'])) return true;
      // Waiting in the lobby (host must admit) — count as joined so we record
      // the moment we are let in. Cover the common EN/VI copy variants.
      const body = (document.body.innerText || '').toLowerCase();
      if (/asking to be let in|let you in|when someone lets you|waiting for (the host|someone)|you'?ll join the call|đang yêu cầu|chờ (được|cho)|sắp được vào|sẽ tham gia .* khi|yêu cầu tham gia đã/.test(body)) {
        return true;
      }
      return false;
    });
  }

  async _joinMeet(page, guestName) {
    // Wait for the pre-join screen to actually render its controls.
    await page.waitForFunction(
      (keys) => {
        const txt = (document.body.innerText || '').toLowerCase();
        const hasBtn = [...document.querySelectorAll('button, [role="button"]')].some((b) => {
          const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
          return keys.some((k) => t.includes(k));
        });
        return hasBtn || /your name|tên của bạn|getting ready|ready to join/.test(txt);
      },
      { timeout: 45000 },
      JOIN_KEYS
    ).catch(() => {});

    await this._dismissPopups(page);
    await this._setMicCamOff(page);
    await this._enterGuestName(page, guestName);

    // Click Join, then WAIT — do not keep mashing the button once the request
    // is in flight (that can cancel/re-trigger "Ask to join"). Only re-click if
    // the join button is still sitting there after we waited (click didn't take).
    let joined = false;
    let requested = false;
    for (let attempt = 0; attempt < 10 && !joined; attempt++) {
      if (await this._isInCallOrLobby(page)) { joined = true; break; }

      if (!requested) {
        const btn = await this._findByText(page, JOIN_KEYS);
        if (btn) {
          if (await this._click(btn)) requested = true;
          await btn.dispose();
        } else {
          await this._dismissPopups(page);
        }
      }

      // Poll for the transition into the call / lobby.
      for (let w = 0; w < 5; w++) {
        await this._sleep(1000);
        if (await this._isInCallOrLobby(page)) { joined = true; break; }
      }

      // Click didn't register (join button still present) → allow a retry.
      if (requested && !joined) {
        const stillThere = await this._findByText(page, JOIN_KEYS);
        if (stillThere) { await stillThere.dispose(); requested = false; }
      }
    }

    if (!joined) {
      throw new Error(
        'Không vào được Meet (không bấm được nút Tham gia hoặc bị chặn).\n' +
        '• Meet có thể yêu cầu đăng nhập Google → cấu hình GOOGLE_EMAIL/PASSWORD hoặc chạy `npm run login`.\n' +
        '• Hoặc host cần bật cho phép khách / duyệt người tham gia.'
      );
    }

    // Re-confirm mic/cam off once inside.
    await this._sleep(3000);
    await this._setMicCamOff(page);
  }

  async _startFFmpeg(displayNum, resolution, fps, crf, duration, outputPath) {
    const logPath = outputPath.replace('.mp4', '.log');

    const ffmpeg = spawn('ffmpeg', [
      '-f', 'x11grab',
      '-video_size', resolution,
      '-framerate', String(fps),
      '-thread_queue_size', '512',
      '-i', `:${displayNum}`,
      '-f', 'pulse',
      '-thread_queue_size', '512',
      '-i', 'virtual_speaker.monitor',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-af', 'aresample=async=1',
      '-t', String(duration),
      '-y', outputPath,
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: `:${displayNum}` },
    });

    const logStream = fs.createWriteStream(logPath);
    ffmpeg.stdout.pipe(logStream);
    ffmpeg.stderr.pipe(logStream);

    this.state.ffmpegPid = ffmpeg.pid;

    ffmpeg.on('exit', () => {
      if (this.state.recording) {
        this._onRecordingStopped();
      }
    });

    await this._sleep(2000);
    try {
      process.kill(ffmpeg.pid, 0);
    } catch {
      throw new Error('FFmpeg không khởi động được!');
    }

    this._ffmpegProcess = ffmpeg;
  }

  _stopRecording() {
    if (this._stopping) return; // already stopping (manual stop + disconnect)
    this._stopping = true;
    const proc = this._ffmpegProcess;
    if (proc && proc.pid) {
      try { process.kill(proc.pid, 'SIGINT'); } catch {} // finalize MP4
      // Safety net: force-kill if SIGINT didn't take, but only if it's still
      // the same process we started (don't kill a recycled PID).
      setTimeout(() => {
        if (this._ffmpegProcess === proc) {
          try { process.kill(proc.pid, 'SIGKILL'); } catch {}
        }
      }, 8000);
    }
    // Close the browser shortly after, once FFmpeg has flushed.
    setTimeout(() => { this._closeBrowser(); }, 3000);
  }

  _onRecordingStopped() {
    const outputPath = this.state.outputPath;
    this.state.recording = false;
    this._ffmpegProcess = null;
    this._stopping = false;

    let size = '0B', sizeBytes = 0, duration = 'unknown';
    try {
      const stat = fs.statSync(outputPath);
      sizeBytes = stat.size;
      size = this._formatSize(sizeBytes);
    } catch {}

    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`,
        { timeout: 10000 }
      ).toString().trim();
      const secs = parseFloat(probe);
      if (!isNaN(secs)) {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        duration = `${m}m ${s}s`;
      }
    } catch {}

    this.emit('stopped', {
      path: outputPath,
      filename: path.basename(outputPath),
      size,
      sizeBytes,
      duration,
    });
  }

  _killChromeFallback() {
    // Prefer killing only the Chrome we launched; fall back to a broad pkill
    // only if we don't have its pid (single-Chrome VPS, so still safe-ish).
    const pid = this.state.chromePid;
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); return; } catch {}
    }
    try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
  }

  _closeBrowser() {
    const browser = this._browser;
    this._browser = null;
    this._page = null;
    if (browser) {
      browser.close().catch(() => this._killChromeFallback());
    } else {
      this._killChromeFallback();
    }
  }

  async _cleanup() {
    this._stopping = true;
    this.state.recording = false;
    const pid = (this._ffmpegProcess && this._ffmpegProcess.pid) || this.state.ffmpegPid;
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    this._ffmpegProcess = null;
    this._closeBrowser();
    this._stopping = false;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = Recorder;
