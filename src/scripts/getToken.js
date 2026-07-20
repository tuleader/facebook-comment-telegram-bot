#!/usr/bin/env node

/**
 * getToken.js - Extract AdsManager access token via headless Chromium.
 * Ported and simplified from tool-fb/src/scripts/getToken.js for single-account bot.
 *
 * Usage:
 *   node src/scripts/getToken.js --cookie-file <path_or_json> --token-file <out_path>
 */

const fs = require('fs');
const path = require('path');
const {
  cleanupBrowser,
  detectCheckpoint,
  envInt,
  gotoPage,
  hardenPage,
  launchFacebookBrowser,
  parseCookieString,
  setFacebookCookies,
} = require('./browserRuntime');

let cookieFile = null;
let tokenFile = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--cookie-file' && process.argv[i + 1]) {
    cookieFile = process.argv[++i];
  } else if (arg === '--token-file' && process.argv[i + 1]) {
    tokenFile = process.argv[++i];
  }
}

if (!cookieFile || !tokenFile) {
  console.error('Usage: node getToken.js --cookie-file <path> --token-file <path>');
  process.exit(1);
}

const pageLoadTimeoutMs = envInt('CHROME_PAGE_LOAD_TIMEOUT_SECONDS', 60) * 1000;
const ADS_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureFolder(filePath) {
  const folder = path.dirname(filePath);
  if (folder && !fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
}

function getCookiesFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`Lỗi load cookies: File không tồn tại: ${filePath}`);
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    console.log(`Lỗi load cookies: File rỗng: ${filePath}`);
    return null;
  }

  // Check if JSON format
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.cookies;
      if (Array.isArray(list) && list.length > 0) {
        return list.map(c => {
          let domain = c.domain || '.facebook.com';
          if (domain && !domain.includes('facebook.com')) domain = '.facebook.com';
          return {
            name: c.name,
            value: c.value,
            domain,
            path: c.path || '/',
          };
        }).filter(c => c.name && c.value);
      }
    } catch (_) {
      // Fallback to string parsing if JSON parse fails
    }
  }

  // Parse as cookie header text: "name1=value1; name2=value2"
  return parseCookieString(raw);
}

async function loadCookies(page) {
  await gotoPage(page, 'https://www.facebook.com', pageLoadTimeoutMs);
  await sleep(2000);

  const cookies = getCookiesFromFile(cookieFile);
  if (!cookies || cookies.length === 0) {
    console.log('Lỗi load cookies: Không thể đọc hoặc parse cookies từ file');
    return false;
  }

  await setFacebookCookies(page, cookies);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: pageLoadTimeoutMs });
  console.log('Đã inject cookies và load trang chủ Facebook.');
  return true;
}

async function getAccessToken(page) {
  try {
    console.log('Đang mở AdsManager...');
    await gotoPage(page, ADS_URL, pageLoadTimeoutMs);

    for (let attempt = 0; attempt < 30; attempt++) {
      const checkpointReason = await detectCheckpoint(page);
      if (checkpointReason) {
        console.log(`CHECKPOINT: ${checkpointReason}`);
        return null;
      }

      const source = await page.content();
      const match = source.match(/window\.__accessToken="(EAAB[^"]+)"/);
      if (match) {
        console.log('Lấy token AdsManager (window.__accessToken) thành công');
        return match[1];
      }
      await sleep(500);
    }

    const checkpointReason = await detectCheckpoint(page);
    if (checkpointReason) {
      console.log(`CHECKPOINT: ${checkpointReason}`);
    } else {
      console.log(`Không tìm thấy token. URL hiện tại: ${page.url()}`);
    }
    return null;
  } catch (error) {
    console.log('Lỗi khi lấy token:', error.message);
    return null;
  }
}

async function main() {
  let browser = null;
  let userDataDir = null;

  try {
    ({ browser, userDataDir } = await launchFacebookBrowser('1280,900'));
    const page = await browser.newPage();
    await hardenPage(page);
    page.setDefaultNavigationTimeout(pageLoadTimeoutMs);
    page.setDefaultTimeout(pageLoadTimeoutMs);

    if (!(await loadCookies(page))) {
      process.exitCode = 1;
      return;
    }

    const token = await getAccessToken(page);
    if (token) {
      ensureFolder(tokenFile);
      fs.writeFileSync(tokenFile, token, 'utf8');
      console.log(`Đã lưu token mới vào ${tokenFile}`);
    } else {
      console.log('THẤT BẠI: Không lấy được token!');
      process.exitCode = 1;
    }
  } finally {
    await cleanupBrowser(browser, userDataDir);
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(async error => {
    console.error(error.message);
    process.exitCode = 1;
    process.exit(1);
  });
