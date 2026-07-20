const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { COOKIE_PATH, TOKEN_PATH, getToken } = require('./storage');

let activeRefreshPromise = null;

/**
 * Automatically refresh/extract Facebook access token using headless Chromium.
 * Runs src/scripts/getToken.js as a child process.
 */
async function ensureFreshToken(options = {}) {
  if (activeRefreshPromise) {
    console.log('[tokenHelper] A token refresh is already in progress, joining existing promise...');
    return await activeRefreshPromise;
  }
  activeRefreshPromise = (async () => {
    try {
      return await doEnsureFreshToken(options);
    } finally {
      activeRefreshPromise = null;
    }
  })();
  return await activeRefreshPromise;
}

async function doEnsureFreshToken(options = {}) {
  const { forceRefresh = false, onProgress } = options;

  if (!fs.existsSync(COOKIE_PATH)) {
    throw new Error('Chưa có file cookies (facebook_cookie.json), không thể tự lấy token.');
  }

  if (onProgress) {
    await onProgress({
      stage: 'token_refresh_start',
      message: '⏳ Token hết hạn, đang tự động mở AdsManager bằng Chromium để lấy token mới...',
    });
  }

  console.log('[tokenHelper] Bắt đầu chạy getToken.js để lấy token tự động...');

  const scriptPath = path.join(__dirname, 'scripts', 'getToken.js');
  const execBin = process.execPath;
  const args = [
    scriptPath,
    '--cookie-file', COOKIE_PATH,
    '--token-file', TOKEN_PATH,
  ];

  const output = await new Promise((resolve, reject) => {
    execFile(
      execBin,
      args,
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, FB_HEADLESS: process.env.FB_HEADLESS || 'true' } },
      (error, stdout, stderr) => {
        const fullLog = `${stdout || ''}\n${stderr || ''}`.trim();
        if (fullLog.includes('CHECKPOINT:')) {
          const checkpointLine = fullLog.split('\n').find(l => l.includes('CHECKPOINT:')) || fullLog;
          const err = new Error(`Account Facebook bị checkpoint/lock: ${checkpointLine}`);
          err.isCheckpoint = true;
          return reject(err);
        }
        if (error) {
          const err = new Error(`Lấy token tự động thất bại: ${fullLog || error.message}`);
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve(fullLog);
      }
    );
  });

  console.log('[tokenHelper] getToken output:', output);

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('Chạy getToken.js xong nhưng không tìm thấy file token_path.');
  }

  const newToken = getToken();
  console.log('[tokenHelper] Đã lấy token mới thành công.');

  if (onProgress) {
    await onProgress({
      stage: 'token_refresh_done',
      message: '✅ Đã lấy và cập nhật token mới bằng Chromium thành công!',
    });
  }

  return newToken;
}

module.exports = {
  ensureFreshToken,
};
