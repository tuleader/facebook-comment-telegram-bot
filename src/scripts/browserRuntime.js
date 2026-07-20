/**
 * browserRuntime.js – Puppeteer helpers for headless Chromium operations.
 * Ported from tool-fb/src/scripts/browserRuntime.js
 *
 * Uses puppeteer-core (no bundled Chrome – expects system Chromium).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

function envBool(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, defaultValue) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse a cookie header string "name1=value1; name2=value2" into Puppeteer cookie objects.
 */
function parseCookieString(cookieString) {
  return String(cookieString || '')
    .split(';')
    .map(raw => raw.trim())
    .filter(Boolean)
    .map(raw => {
      const sep = raw.indexOf('=');
      if (sep <= 0) return null;
      const name = raw.slice(0, sep).trim();
      const value = raw.slice(sep + 1).trim();
      if (!name) return null;
      return { name, value, domain: '.facebook.com', path: '/' };
    })
    .filter(Boolean);
}

function hasRequiredCookieSignals(cookies) {
  const names = new Set((cookies || []).map(c => c.name));
  return names.has('c_user') && names.has('xs');
}

/**
 * Auto-detect system Chromium/Chrome binary if PUPPETEER_EXECUTABLE_PATH is not set.
 */
function findSystemChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Launch Chromium with anti-detect args for Facebook.
 */
async function launchFacebookBrowser(windowSize = '1280,900') {
  const shouldRunHeadless = envBool('FB_HEADLESS', true);
  const executablePath = findSystemChrome();
  const [width, height] = String(windowSize).split(',').map(v => Number.parseInt(v, 10));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bot-puppeteer-'));

  const launchOptions = {
    headless: shouldRunHeadless ? true : false,
    executablePath,
    defaultViewport: {
      width: Number.isFinite(width) ? width : 1280,
      height: Number.isFinite(height) ? height : 900,
    },
    args: [
      `--user-data-dir=${userDataDir}`,
      `--window-size=${windowSize}`,
      '--disable-notifications',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-features=Translate,TranslateUI,AutomationControlled',
      '--disable-translate',
      '--blink-settings=imagesEnabled=false',
      '--lang=vi-VN',
    ],
  };

  const browser = await puppeteer.launch(launchOptions);
  return { browser, userDataDir };
}

async function cleanupBrowser(browser, userDataDir) {
  if (browser) {
    try {
      const proc = browser.process();
      await browser.close();
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    } catch (_) {}
  }
  if (userDataDir && fs.existsSync(userDataDir)) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

async function hardenPage(page) {
  await page.setUserAgent(
    process.env.FB_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => null);
}

async function gotoPage(page, url, timeoutMs) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
}

async function setFacebookCookies(page, cookies) {
  if (!cookies || cookies.length === 0) return;
  await page.setCookie(...cookies);
}

const CHECKPOINT_URL_MARKERS = [
  'checkpoint',
  'login_checkpoint',
  'two_factor',
  'recover/initiate',
];

const CHECKPOINT_TEXT_MARKERS = [
  'security check',
  'confirm your identity',
  'verify your identity',
  'account temporarily locked',
  'we suspended your account',
  'tài khoản của bạn đã bị khóa',
  'xác nhận danh tính',
  'kiểm tra bảo mật',
];

async function detectCheckpoint(page) {
  const currentUrl = String(page.url() || '');
  const normalizedUrl = currentUrl.toLowerCase();

  if (CHECKPOINT_URL_MARKERS.some(marker => normalizedUrl.includes(marker))) {
    return `Account bị checkpoint/lock, URL hiện tại: ${currentUrl}`;
  }

  let source = '';
  try { source = String(await page.content()).toLowerCase(); } catch (_) { source = ''; }

  if (CHECKPOINT_TEXT_MARKERS.some(marker => source.includes(marker))) {
    return `Account bị checkpoint/lock, URL hiện tại: ${currentUrl}`;
  }

  return null;
}

function readCookieString(cookieFile, envName = 'FB_COOKIE') {
  const envCookie = String(process.env[envName] || '').trim();
  if (envCookie) return envCookie;
  if (!fs.existsSync(cookieFile)) return '';
  return fs.readFileSync(cookieFile, 'utf8').trim();
}

module.exports = {
  cleanupBrowser,
  detectCheckpoint,
  envInt,
  gotoPage,
  hardenPage,
  hasRequiredCookieSignals,
  launchFacebookBrowser,
  parseCookieString,
  readCookieString,
  setFacebookCookies,
};
