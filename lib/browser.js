/**
 * Shared browser helpers
 *
 * Wraps puppeteer-core with puppeteer-extra + the stealth plugin so the
 * automated Chrome looks like a normal browser (this is why a phone can join
 * a Meet but a naked headless Chrome often cannot — Google flags it as a bot).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

function resolveChromePath(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  try {
    const found = execSync(
      'which google-chrome 2>/dev/null || which google-chrome-stable 2>/dev/null || which chromium 2>/dev/null || which chromium-browser 2>/dev/null',
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim().split('\n')[0];
    if (found) return found;
  } catch {}
  return 'google-chrome';
}

function defaultProfileDir(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PROFILE_DIR) return process.env.CHROME_PROFILE_DIR;
  return path.join(os.homedir(), '.meet-recorder', 'chrome-profile');
}

/**
 * Launch a stealth Chrome bound to an X display (so FFmpeg x11grab can capture
 * it) using a PERSISTENT user-data-dir so a Google login survives restarts.
 */
async function launchBrowser({
  profileDir,
  chromePath,
  displayNum,
  width = 1280,
  height = 720,
  extraArgs = [],
} = {}) {
  const userDataDir = defaultProfileDir(profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Stale singleton lock files prevent a persistent profile from reopening
  // after a crash / hard kill. Remove them (NOT the whole profile — that would
  // throw away the saved Google session).
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userDataDir, lock), { force: true }); } catch {}
  }

  const env = { ...process.env };
  if (displayNum != null) env.DISPLAY = `:${displayNum}`;
  // Force Chrome's audio into the virtual sink FFmpeg records from, regardless
  // of the system default sink.
  if (!env.PULSE_SINK) env.PULSE_SINK = 'virtual_speaker';

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-notifications',
    '--disable-infobars',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=/tmp/silence.wav',
    '--use-file-for-fake-video-capture=/tmp/black.mjpeg',
    '--disable-features=Translate,TranslateUI,MediaRouter',
    '--lang=en-US',
    ...extraArgs,
  ];

  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(chromePath),
    headless: false, // must render on the X display for x11grab capture
    userDataDir,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    env,
    args,
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  // Pre-grant mic/cam so Meet never blocks on a permission prompt.
  try {
    await browser.defaultBrowserContext()
      .overridePermissions('https://meet.google.com', ['microphone', 'camera']);
  } catch {}

  return { browser, page };
}

module.exports = { puppeteer, launchBrowser, resolveChromePath, defaultProfileDir };
