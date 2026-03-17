/**
 * Meet Recorder Engine
 * 
 * Handles: Xvfb → Chrome (CDP) → PulseAudio → FFmpeg pipeline
 */

const { spawn, exec, execSync } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

class Recorder extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
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

    const { displayNum, resolution, fps, crf, cdpPort, guestName, recordingsDir, minParticipants } = this.config;
    const [width, height] = resolution.split('x').map(Number);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const outputPath = path.join(recordingsDir, `meet_${timestamp}.mp4`);

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

      // 3. Create silent fake media
      this._createFakeMedia();

      // 4. Chrome
      this.emit('stage', 'chrome');
      await this._launchChrome(meetUrl, displayNum, width, height, cdpPort);

      // 5. Join Meet via CDP
      this.emit('stage', 'joining');
      await this._joinMeet(cdpPort, guestName);

      // 6. FFmpeg
      this.emit('stage', 'recording');
      await this._startFFmpeg(displayNum, resolution, fps, crf, duration, outputPath);

      // 7. Participant monitor
      this._startParticipantMonitor(cdpPort, minParticipants);

      return outputPath;

    } catch (err) {
      this._cleanup();
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
    
    // Check if Xvfb is running
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

    // Verify
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

    // Ensure virtual sink exists
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

  async _launchChrome(url, displayNum, width, height, cdpPort) {
    // Kill existing
    try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
    await this._sleep(1000);

    // Clean old user-data-dir to prevent Chrome from restoring old sessions
    try { execSync('rm -rf /tmp/chrome-meet-recorder 2>/dev/null'); } catch {}

    const chrome = spawn('google-chrome', [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--window-size=${width},${height}`, '--window-position=0,0',
      '--no-first-run', '--no-default-browser-check',
      '--disable-notifications',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=/tmp/silence.wav',
      '--use-file-for-fake-video-capture=/tmp/black.mjpeg',
      '--disable-features=TranslateUI',
      '--user-data-dir=/tmp/chrome-meet-recorder',
      `--remote-debugging-port=${cdpPort}`,
      url,
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: `:${displayNum}` },
    });
    chrome.unref();
    this.state.chromePid = chrome.pid;

    // Wait for Chrome to be ready
    await this._waitForCDP(cdpPort, 20000);
  }

  async _waitForCDP(port, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const http = require('http');
        await new Promise((resolve, reject) => {
          const req = http.get(`http://localhost:${port}/json`, (res) => {
            let data = '';
            res.on('data', (d) => data += d);
            res.on('end', () => { resolve(data); });
          });
          req.on('error', reject);
          req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
        });
        return;
      } catch {
        await this._sleep(1000);
      }
    }
    throw new Error('Chrome không phản hồi CDP!');
  }

  async _joinMeet(cdpPort, guestName) {
    const http = require('http');

    // Retry loop: Chrome may still be navigating when CDP first becomes ready
    let meetPage = null;
    const deadline = Date.now() + 20000; // wait up to 20s for navigation
    while (Date.now() < deadline) {
      const pagesRaw = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${cdpPort}/json`, (res) => {
          let d = '';
          res.on('data', (c) => d += c);
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      const pages = JSON.parse(pagesRaw);
      meetPage = pages.find(p => p.url && p.url.includes('meet.google.com'));
      if (meetPage) break;
      await this._sleep(1500);
    }

    if (!meetPage) throw new Error('Meet page không tìm thấy trên Chrome!');

    // Wait for page to load
    await this._sleep(8000);

    // Connect CDP WebSocket and automate join
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout khi join Meet (60s)'));
      }, 60000);

      const ws = new WebSocket(meetPage.webSocketDebuggerUrl);
      let step = 0;

      const send = (id, js) => {
        ws.send(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: js },
        }));
      };

      ws.on('open', () => {
        // Step 1: Dismiss any popup
        send(1, `(function(){
          for(const b of document.querySelectorAll('button')){
            if(b.textContent.trim()==='Got it'){b.click();return 'dismissed'}
          }
          return 'no popup'
        })()`);
      });

      ws.on('message', (data) => {
        let r;
        try { r = JSON.parse(data); } catch { return; }
        if (!r.result?.result) return;
        const val = r.result.result.value;
        step++;

        if (step === 1) {
          // Step 2: Turn OFF mic/cam
          setTimeout(() => send(2, `(function(){
            let r = [];
            for(const b of document.querySelectorAll('button[aria-label]')){
              const l = (b.getAttribute('aria-label')||'').toLowerCase();
              if(l.includes('turn off microphone') || l.includes('tắt micrô')){ b.click(); r.push('mic off'); }
              if(l.includes('turn off camera') || l.includes('tắt camera')){ b.click(); r.push('cam off'); }
            }
            return r.length ? r.join(', ') : 'already off or not found';
          })()`), 1000);
        }

        if (step === 2) {
          // Step 3: Type guest name
          setTimeout(() => send(3, `(function(){
            const inp = document.querySelector('input');
            if(!inp) return 'no input';
            inp.focus();
            const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            s.call(inp, '${guestName}');
            inp.dispatchEvent(new Event('input',{bubbles:true}));
            return 'name set';
          })()`), 1000);
        }

        if (step === 3) {
          // Step 4: Click Join
          setTimeout(() => send(4, `(function(){
            for(const b of document.querySelectorAll('button')){
              const t = b.textContent.trim().toLowerCase();
              if(t.includes('join now') || t.includes('ask to join') || t.includes('tham gia')){
                b.click(); return 'joined: ' + t;
              }
            }
            // Try span inside buttons
            for(const s of document.querySelectorAll('button span')){
              const t = s.textContent.trim().toLowerCase();
              if(t.includes('join') || t.includes('tham gia')){
                s.closest('button').click(); return 'joined via span: ' + t;
              }
            }
            return 'join button not found';
          })()`), 2000);
        }

        if (step === 4) {
          // Step 5: After join — double-check mic/cam OFF
          setTimeout(() => send(5, `(function(){
            let r = [];
            for(const b of document.querySelectorAll('button[aria-label]')){
              const l = (b.getAttribute('aria-label')||'').toLowerCase();
              if(l.includes('turn off microphone') || l.includes('tắt micrô')){b.click();r.push('mic forced off');}
              if(l.includes('turn off camera') || l.includes('tắt camera')){b.click();r.push('cam forced off');}
            }
            return r.length ? r.join(', ') : 'mic/cam confirmed off';
          })()`), 8000);
        }

        if (step === 5) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`CDP WebSocket lỗi: ${err.message}`));
      });
    });
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
      '-af', 'aresample=async=1',  // Fix audio DTS issues
      '-t', String(duration),
      '-y', outputPath,
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: `:${displayNum}` },
    });

    // Log FFmpeg output
    const logStream = fs.createWriteStream(logPath);
    ffmpeg.stdout.pipe(logStream);
    ffmpeg.stderr.pipe(logStream);

    this.state.ffmpegPid = ffmpeg.pid;

    ffmpeg.on('exit', (code) => {
      if (this.state.recording) {
        this._onRecordingStopped();
      }
    });

    // Verify ffmpeg started
    await this._sleep(2000);
    try {
      process.kill(ffmpeg.pid, 0);
    } catch {
      throw new Error('FFmpeg không khởi động được!');
    }

    this._ffmpegProcess = ffmpeg;
  }

  _stopRecording() {
    this._stopParticipantMonitor();
    if (this._ffmpegProcess) {
      try {
        // Graceful stop with SIGINT (finalize MP4)
        process.kill(this._ffmpegProcess.pid, 'SIGINT');
      } catch {}
    }
    // Kill Chrome after a delay
    setTimeout(() => {
      try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
    }, 3000);
  }

  _onRecordingStopped() {
    const outputPath = this.state.outputPath;
    this.state.recording = false;

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

  _cleanup() {
    this._stopParticipantMonitor();
    this.state.recording = false;
    try { execSync('pkill -9 -f "google-chrome" 2>/dev/null'); } catch {}
    if (this.state.ffmpegPid) {
      try { process.kill(this.state.ffmpegPid, 'SIGKILL'); } catch {}
    }
  }

  _startParticipantMonitor(cdpPort, threshold) {
    let lowCount = 0;
    this._participantTimer = setInterval(async () => {
      if (!this.state.recording) { this._stopParticipantMonitor(); return; }
      try {
        const count = await this._checkParticipantCount(cdpPort);
        if (count >= 0 && count < threshold) {
          lowCount++;
          if (lowCount >= 2) {
            this._stopParticipantMonitor();
            this.emit('participant-low', count);
            this._stopRecording();
          }
        } else {
          lowCount = 0;
        }
      } catch { /* ignore monitoring errors */ }
    }, 30000);
  }

  _stopParticipantMonitor() {
    if (this._participantTimer) {
      clearInterval(this._participantTimer);
      this._participantTimer = null;
    }
  }

  async _checkParticipantCount(cdpPort) {
    const http = require('http');
    const pagesRaw = await new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${cdpPort}/json`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    const pages = JSON.parse(pagesRaw);
    const meetPage = pages.find(p => p.url && p.url.includes('meet.google.com'));
    if (!meetPage) return -1;

    return new Promise((resolve) => {
      const ws = new WebSocket(meetPage.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(-1); }, 5000);

      ws.once('open', () => {
        ws.send(JSON.stringify({
          id: 99,
          method: 'Runtime.evaluate',
          params: {
            expression: `(function(){
              // Strategy 1: participant tiles (data-participant-id)
              const tiles = document.querySelectorAll('[data-participant-id]');
              if (tiles.length > 0) return tiles.length;
              // Strategy 2: video grid allocation slots
              const cells = document.querySelectorAll('[data-allocation-index]');
              if (cells.length > 0) return cells.length;
              // Strategy 3: visible video elements
              const vids = Array.from(document.querySelectorAll('video')).filter(v => v.videoWidth > 0);
              if (vids.length > 0) return vids.length;
              // Strategy 4: people count in toolbar button aria-label
              for (const btn of document.querySelectorAll('button')) {
                const label = btn.getAttribute('aria-label') || '';
                const m = label.match(/(\\d+)\\s*(people|participants|ng)/i);
                if (m) return parseInt(m[1]);
              }
              return 0;
            })()`,
          },
        }));
      });

      ws.once('message', (data) => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        try {
          const r = JSON.parse(data);
          const val = r?.result?.result?.value;
          resolve(typeof val === 'number' ? val : -1);
        } catch { resolve(-1); }
      });

      ws.once('error', () => { clearTimeout(timer); try { ws.close(); } catch {} resolve(-1); });
    });
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = Recorder;
