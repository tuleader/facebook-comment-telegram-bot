const fs = require('fs');
const path = require('path');
const { DATA_DIR, STATE_DIR } = require('./config');

const COOKIE_PATH = path.join(DATA_DIR, 'facebook_cookie.json');
const TOKEN_PATH = path.join(DATA_DIR, 'facebook_token.txt');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function backupIfExists(file, prefix) {
  ensureDirs();
  if (!fs.existsSync(file)) return null;
  const ext = path.extname(file) || '.bak';
  const backup = path.join(DATA_DIR, `${prefix}_backup_${Date.now()}${ext}`);
  fs.copyFileSync(file, backup);
  return backup;
}

function validateCookieJar(jar, sourceLabel = 'Cookie') {
  const cookies = Array.isArray(jar) ? jar : jar.cookies;
  if (!Array.isArray(cookies) || !cookies.length) throw new Error(`${sourceLabel} không hợp lệ: thiếu cookies[]`);
  const names = new Set(cookies.map(c => c && c.name).filter(Boolean));
  for (const name of ['c_user', 'xs']) {
    if (!names.has(name)) throw new Error(`${sourceLabel} thiếu cookie bắt buộc: ${name}`);
  }
  return Array.isArray(jar) ? { url: 'https://www.facebook.com', cookies } : { url: jar.url || 'https://www.facebook.com', cookies };
}

function parseCookieHeaderText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Cookie text rỗng.');
  const cookies = [];
  for (const part of raw.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!name || !value) continue;
    cookies.push({
      domain: '.facebook.com',
      path: '/',
      name,
      value,
      secure: true,
      httpOnly: ['sb', 'datr', 'fr', 'xs'].includes(name),
      sameSite: 'no_restriction',
      session: true,
    });
  }
  return validateCookieJar({ url: 'https://www.facebook.com', cookies }, 'Cookie header');
}

function loadCookieJarFromFile(file) {
  const content = fs.readFileSync(path.resolve(file), 'utf8').trim();
  if (!content) throw new Error('File cookie rỗng.');
  if (content.startsWith('{') || content.startsWith('[')) {
    return validateCookieJar(JSON.parse(content), 'Cookie JSON');
  }
  return parseCookieHeaderText(content);
}

function saveCookieJar(jar) {
  ensureDirs();
  const validJar = validateCookieJar(jar, 'Cookie');
  const backup = backupIfExists(COOKIE_PATH, 'facebook_cookie');
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(validJar, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(COOKIE_PATH, 0o600);
  return {
    cookieCount: validJar.cookies.length,
    c_user: validJar.cookies.find(c => c.name === 'c_user')?.value || null,
    backup,
  };
}

function saveCookieFile(file) {
  return saveCookieJar(loadCookieJarFromFile(file));
}

function saveCookieText(text) {
  return saveCookieJar(parseCookieHeaderText(text));
}

function loadCookieJar() {
  if (!fs.existsSync(COOKIE_PATH)) throw new Error('Chưa có cookie. Gửi file cookie JSON với lệnh: fb lưu cookie');
  return loadCookieJarFromFile(COOKIE_PATH);
}

function getCookieHeader() {
  const jar = loadCookieJar();
  return jar.cookies
    .filter(c => c && c.name && typeof c.value === 'string')
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

function saveToken(rawToken) {
  ensureDirs();
  const token = String(rawToken || '').trim().replace(/^['"]|['"]$/g, '');
  if (token.length < 40) throw new Error('Token quá ngắn hoặc không hợp lệ.');
  const backup = backupIfExists(TOKEN_PATH, 'facebook_token');
  fs.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
  return { tokenLength: token.length, tokenPrefix: token.slice(0, 8), backup };
}

function getToken(options = {}) {
  const allowEmpty = typeof options === 'object' && options !== null ? options.allowEmpty : false;
  if (!fs.existsSync(TOKEN_PATH)) {
    if (allowEmpty) return null;
    throw new Error('Chưa có token. Hãy gửi update_cookies để bot tự lấy token.');
  }
  const token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  if (token.length < 40) {
    if (allowEmpty) return null;
    throw new Error('Token đang lưu quá ngắn hoặc không hợp lệ.');
  }
  return token;
}

function status() {
  let cookieOk = false, cookieCount = 0, c_user = null, tokenOk = false, tokenLength = 0;
  try {
    const jar = loadCookieJar();
    cookieOk = true;
    cookieCount = jar.cookies.length;
    c_user = jar.cookies.find(c => c.name === 'c_user')?.value || null;
  } catch (_) {}
  try {
    const token = getToken();
    tokenOk = true;
    tokenLength = token.length;
  } catch (_) {}
  return { cookieOk, cookieCount, c_user, tokenOk, tokenLength };
}

module.exports = {
  COOKIE_PATH,
  TOKEN_PATH,
  ensureDirs,
  saveCookieFile,
  saveCookieText,
  parseCookieHeaderText,
  getCookieHeader,
  saveToken,
  getToken,
  status,
};
