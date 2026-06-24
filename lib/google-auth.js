/**
 * Google account login (hybrid strategy)
 *
 *  - Prefer the session already saved in the persistent Chrome profile.
 *  - Only if not signed in AND credentials are provided, do an automated login.
 *  - Login failures are NON-fatal: we fall back to guest join so public Meets
 *    still record.
 *
 * NOTE: automated Google login on a server is inherently fragile. Use a
 * DEDICATED account with 2-Step Verification turned OFF, or do a one-time
 * manual login via `npm run login`.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, keys) {
  const handle = await page.evaluateHandle((kw) => {
    const all = [...document.querySelectorAll('button, [role="button"]')];
    for (const b of all) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (kw.some((k) => t === k || t.includes(k))) return b;
    }
    return null;
  }, keys);
  const el = handle.asElement();
  if (el) {
    try { await el.click({ delay: 40 }); }
    catch { try { await el.evaluate((b) => b.click()); } catch {} }
    await el.dispose();
    return true;
  }
  await handle.dispose();
  return false;
}

/** Probe whether the current profile is signed into a Google account. */
async function isSignedIn(page) {
  try {
    await page.goto('https://myaccount.google.com/', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
  } catch {}
  await sleep(1500);
  const url = page.url();
  if (/signin|ServiceLogin|accounts\.google\.com\/(?:v\d\/)?signin/i.test(url)) return false;
  if (!url.includes('myaccount.google.com')) return false;
  // Confirm there's no login form on the page (guards against odd redirects).
  const hasLoginForm = await page
    .$('input[type="email"], input[type="password"]')
    .then((h) => !!h)
    .catch(() => false);
  return !hasLoginForm;
}

/** Perform an automated email/password login. Returns true if confirmed. */
async function googleLogin(page, email, password, log = () => {}) {
  log('Đăng nhập Google...');
  try {
    await page.goto(
      'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmyaccount.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );

    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 25000 });
    await page.type('input[type="email"]', email, { delay: 60 });
    if (!(await clickByText(page, ['next', 'tiếp theo']))) {
      await page.click('#identifierNext').catch(() => {});
    }

    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 30000 });
    await sleep(900);
    await page.type('input[type="password"]', password, { delay: 60 });
    if (!(await clickByText(page, ['next', 'tiếp theo']))) {
      await page.click('#passwordNext').catch(() => {});
    }

    // Wait until we leave the sign-in / challenge flow.
    await page.waitForFunction(
      () => {
        const h = location.href;
        return !/\/signin\/|\/challenge\/|ServiceLogin|pwd|identifier/i.test(h);
      },
      { timeout: 45000 }
    ).catch(() => {});

    // Surface the common reasons automated login gets stuck.
    const u = page.url();
    if (/challenge|deniedsigninrejected|signin\/rejected|disabled|InteractiveSignInRequired/i.test(u)) {
      log('⚠️ Google yêu cầu xác minh thêm (2FA / "xác minh đó là bạn" / CAPTCHA / chặn đăng nhập).');
      log('   Dùng tài khoản KHÔNG bật 2FA, hoặc đăng nhập thủ công 1 lần qua `npm run login`.');
      return false;
    }

    // Dismiss "add recovery info / not now" style interstitials if present.
    await clickByText(page, ['not now', 'để sau', 'bỏ qua', 'skip']);
    await sleep(800);
    return true;
  } catch (e) {
    log(`Lỗi đăng nhập: ${e.message}`);
    return false;
  }
}

/**
 * Hybrid: reuse saved session, else login with credentials if available.
 * Returns true if signed in, false if continuing as guest.
 */
async function ensureLoggedIn(page, { email, password } = {}, log = () => {}) {
  if (!email || !password) return false; // guest mode — no creds configured
  try {
    if (await isSignedIn(page)) {
      log('Đã có session Google (dùng lại).');
      return true;
    }
    await googleLogin(page, email, password, log);
    const ok = await isSignedIn(page);
    if (!ok) log('Không xác nhận được đăng nhập Google — tiếp tục dưới dạng guest.');
    return ok;
  } catch (e) {
    log(`Đăng nhập Google thất bại: ${e.message} — tiếp tục dưới dạng guest.`);
    return false;
  }
}

module.exports = { isSignedIn, googleLogin, ensureLoggedIn };
