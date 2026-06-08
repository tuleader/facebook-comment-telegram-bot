const fs = require('fs');
const path = require('path');
const { AUTHORIZED_USER_ID, STATE_DIR, TELEGRAM_BOT_TOKEN, SHEETS_WEBHOOK_URL, SHEETS_SECRET_TOKEN, DEFAULT_LIMIT, DEFAULT_DELAY_MS } = require('./config');
const { sendMessage, editMessage, getUpdates, downloadFile } = require('./telegram');
const storage = require('./storage');
const { extractPostId, harvestComments, fetchPostInfo, checkFacebookSession } = require('./facebook');
const { buildWorkbook } = require('./workbook');
const { exportWorkbook } = require('./sheets');

let updateOffset = 0;
let currentJob = null;
const sessions = new Map(); // chatId -> { step }

function isAuthorized(message) {
  if (!AUTHORIZED_USER_ID) return true;
  return String(message.from && message.from.id) === String(AUTHORIZED_USER_ID);
}

function normalizeText(message) {
  return String(message.text || message.caption || '').trim();
}

function helpText() {
  return [
    'Facebook Comment Export Bot',
    '',
    'Lệnh hội thoại:',
    'get_cmt / fb get_cmt / fb lấy cmt',
    'get_cmt <URL> top 10  -> thêm tab top_10_tuong_tac',
    'update_cookies / fb update cookies',
    'update_token / fb update token',
    'fb status / fb check',
    '',
    'Flow get_cmt:',
    '1. Bot kiểm tra cookie/token',
    '2. Thiếu cookie thì yêu cầu gửi file cookie JSON hoặc dán cookie text',
    '3. Thiếu token thì yêu cầu gửi token',
    '4. Đủ rồi bot yêu cầu gửi URL bài viết',
    '5. Bot crawl comment và xuất Google Sheet',
    '',
    'Sheet mặc định:',
    '- tat_ca_cmt',
    '- tat_ca_tuong_tac: tất cả user, xếp cao xuống thấp',
    '- nếu có yêu cầu top N thì thêm tab top_N_tuong_tac',
    '',
    `Default: limit=${DEFAULT_LIMIT}, delay=${DEFAULT_DELAY_MS}ms`,
  ].join('\n');
}

function getSession(chatId) {
  return sessions.get(String(chatId));
}
function setSession(chatId, step) {
  sessions.set(String(chatId), { step });
}
function clearSession(chatId) {
  sessions.delete(String(chatId));
}

function isGetCmtCommand(text) {
  return /^(get_cmt|fb\s+get_cmt|fb\s+(lấy\s+cmt|lay\s+cmt|export|lấy\s+comment|lay\s+comment))(\s+.*)?$/i.test(text);
}
function isUpdateCookieCommand(text) {
  return /^(update_cookies|update_cookie|fb\s+update\s+cookies?|fb\s+(lưu|luu|save)\s+cookies?)(\s+.*)?$/i.test(text);
}
function isUpdateTokenCommand(text) {
  return /^(update_token|fb\s+update\s+token|fb\s+(lưu|luu|save)\s+token)(\s+.*)?$/i.test(text);
}
function extractUrlFromGetCommand(text) {
  return String(text || '')
    .replace(/^(get_cmt|fb\s+get_cmt|fb\s+(lấy\s+cmt|lay\s+cmt|export|lấy\s+comment|lay\s+comment))\s*/i, '')
    .trim();
}
function parseTopLimit(text) {
  const s = String(text || '').toLowerCase();
  const patterns = [
    /(?:^|\s)--top(?:=|\s+)(\d{1,4})(?=\s|$)/i,
    /(?:^|\s)top\s*(\d{1,4})(?=\s|$)/i,
    /(?:lấy|lay)\s+top\s*(\d{1,4})/i,
    /top\s+(?:mấy|may)\s*[:=]?\s*(\d{1,4})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return Math.min(n, 1000);
    }
  }
  return null;
}
function extractTokenFromCommand(text) {
  return String(text || '')
    .replace(/^(update_token|fb\s+update\s+token|fb\s+(lưu|luu|save)\s+token)\s*/i, '')
    .trim();
}

async function handleStatus(chatId) {
  const st = storage.status();
  await sendMessage(chatId, [
    'Trạng thái:',
    `- Cookie: ${st.cookieOk ? 'OK' : 'CHƯA CÓ'}${st.cookieOk ? ` (${st.cookieCount} cookies, c_user=${st.c_user})` : ''}`,
    `- Token: ${st.tokenOk ? 'OK' : 'CHƯA CÓ'}${st.tokenOk ? ` (${st.tokenLength} chars)` : ''}`,
    `- Google webhook: ${SHEETS_WEBHOOK_URL && SHEETS_SECRET_TOKEN ? 'OK' : 'CHƯA CẤU HÌNH'}`,
    `- Job đang chạy: ${currentJob ? currentJob : 'không'}`,
    `- Đang chờ: ${getSession(chatId)?.step || 'không'}`,
  ].join('\n'));
}

async function handleCheck(chatId) {
  const st = storage.status();
  if (!st.cookieOk || !st.tokenOk) {
    await sendMessage(chatId, [
      'Chưa đủ dữ liệu để check live:',
      `- Cookie: ${st.cookieOk ? 'OK' : 'CHƯA CÓ'}`,
      `- Token: ${st.tokenOk ? 'OK' : 'CHƯA CÓ'}`,
      '',
      'Gửi update_cookies và update_token trước nhé.',
    ].join('\n'));
    return;
  }
  try {
    const me = await checkFacebookSession();
    await sendMessage(chatId, `Cookie + token còn sống ✅\nFacebook account: ${me.name || 'unknown'} (${me.id || 'unknown'})`);
  } catch (error) {
    const fb = error.facebookError || {};
    await sendMessage(chatId, [
      'Cookie/token có vấn đề hoặc đã hết hạn ❌',
      error.message,
      fb.code ? `Code: ${fb.code}` : '',
      fb.type ? `Type: ${fb.type}` : '',
      '',
      'Hãy gửi lại:',
      '- update_cookies',
      '- update_token',
    ].filter(Boolean).join('\n'));
  }
}

async function askNextForGetCmt(chatId) {
  const st = storage.status();
  if (!st.cookieOk) {
    setSession(chatId, 'awaiting_cookie_for_get');
    await sendMessage(chatId, 'Chưa có cookies. Gửi file cookie JSON hoặc dán cookie header text dạng:\nsb=...; datr=...; c_user=...; xs=...');
    return;
  }
  if (!st.tokenOk) {
    setSession(chatId, 'awaiting_token_for_get');
    await sendMessage(chatId, 'Chưa có token. Gửi token Facebook Graph/Ads vào đây nhé.');
    return;
  }
  setSession(chatId, 'awaiting_url_for_get');
  await sendMessage(chatId, 'Đã có cookies + token ✅\nGửi URL bài viết/live/reel cần lấy comment.');
}

async function saveCookieFromMessage(chatId, message, text = '') {
  let result;
  if (message.document) {
    const localFile = await downloadFile(message.document.file_id, message.document.file_name || 'cookie.json');
    result = storage.saveCookieFile(localFile);
  } else {
    const cookieText = String(text || '').trim();
    if (!cookieText) throw new Error('Cần gửi file cookie JSON hoặc cookie header text dạng `sb=...; c_user=...; xs=...`.');
    result = storage.saveCookieText(cookieText);
  }
  await sendMessage(chatId, `Đã lưu cookies ✅\n- Số cookie: ${result.cookieCount}\n- c_user: ${result.c_user}`);
}

async function saveTokenFromText(chatId, tokenText) {
  const token = String(tokenText || '').trim();
  if (!token) throw new Error('Cần gửi token dạng text.');
  const result = storage.saveToken(token);
  await sendMessage(chatId, `Đã lưu token ✅\n- Độ dài: ${result.tokenLength}\n- Prefix: ${result.tokenPrefix}…`);
}

async function handleInteractiveState(chatId, message, text) {
  const session = getSession(chatId);
  if (!session) return false;

  if (session.step === 'awaiting_cookie_for_get' || session.step === 'awaiting_cookie_update') {
    await saveCookieFromMessage(chatId, message, text);
    if (session.step === 'awaiting_cookie_for_get') await askNextForGetCmt(chatId);
    else clearSession(chatId);
    return true;
  }

  if (session.step === 'awaiting_token_for_get' || session.step === 'awaiting_token_update') {
    await saveTokenFromText(chatId, text);
    if (session.step === 'awaiting_token_for_get') await askNextForGetCmt(chatId);
    else clearSession(chatId);
    return true;
  }

  if (session.step === 'awaiting_url_for_get') {
    if (!text) throw new Error('Cần gửi URL bài viết/live/reel.');
    clearSession(chatId);
    await handleExportUrl(chatId, text);
    return true;
  }

  return false;
}

async function handleUpdateCookies(chatId, message) {
  const inlineCookie = String(normalizeText(message) || '').replace(/^(update_cookies|update_cookie|fb\s+update\s+cookies?|fb\s+(lưu|luu|save)\s+cookies?)\s*/i, '').trim();
  if (message.document || inlineCookie) {
    await saveCookieFromMessage(chatId, message, inlineCookie);
    clearSession(chatId);
    return;
  }
  setSession(chatId, 'awaiting_cookie_update');
  await sendMessage(chatId, 'Gửi file cookie JSON hoặc dán cookie header text dạng:\nsb=...; datr=...; c_user=...; xs=...');
}

async function handleUpdateToken(chatId, text) {
  const token = extractTokenFromCommand(text);
  if (token) {
    await saveTokenFromText(chatId, token);
    clearSession(chatId);
    return;
  }
  setSession(chatId, 'awaiting_token_update');
  await sendMessage(chatId, 'Gửi token mới vào đây nhé.');
}

async function handleGetCmt(chatId, text) {
  const maybeUrl = extractUrlFromGetCommand(text);
  const st = storage.status();

  if (!st.cookieOk || !st.tokenOk) {
    await askNextForGetCmt(chatId);
    return;
  }

  if (maybeUrl) {
    clearSession(chatId);
    await handleExportUrl(chatId, maybeUrl);
    return;
  }

  setSession(chatId, 'awaiting_url_for_get');
  await sendMessage(chatId, 'Gửi URL bài viết/live/reel cần lấy comment.');
}

async function handleExportUrl(chatId, sourceUrl) {
  if (currentJob) {
    await sendMessage(chatId, `Đang có job chạy: ${currentJob}. Đợi job xong rồi gửi tiếp nhé.`);
    return;
  }

  const topLimit = parseTopLimit(sourceUrl);
  const postId = extractPostId(sourceUrl);
  currentJob = postId;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const statusMsg = await sendMessage(chatId, [`Bắt đầu lấy comment postId=${postId}`, topLimit ? `Sẽ thêm tab top_${topLimit}_tuong_tac` : '', 'Đang crawl...'].filter(Boolean).join('\n'));
  let lastProgressAt = 0;

  try {
    const { result, outPath } = await harvestComments({
      postId,
      onProgress: async p => {
        const now = Date.now();
        const shouldUpdate = p.topPages === 1 || p.topPages % 10 === 0 || !p.hasNextPage || now - lastProgressAt > 15000;
        if (!shouldUpdate) return;
        lastProgressAt = now;
        await editMessage(chatId, statusMsg.message_id, [
          `Đang crawl postId=${postId}`,
          `- Page: ${p.topPages}`,
          `- Comment gốc: ${p.topLevelCount}`,
          `- Reply: ${p.replyCount}`,
          `- Tổng: ${p.totalCommentCount}`,
          `- Next: ${p.hasNextPage ? 'còn' : 'hết'}`,
          p.possiblePaginationCutoff ? '⚠️ Có dấu hiệu bị cắt pagination sớm.' : '',
        ].filter(Boolean).join('\n'));
      },
    });

    await editMessage(chatId, statusMsg.message_id, [
      `Crawl xong postId=${postId}`,
      `- Comment gốc: ${result.topLevelCount}`,
      `- Reply: ${result.replyCount}`,
      `- Tổng: ${result.totalCommentCount}`,
      'Đang xuất Google Sheet...',
    ].join('\n'));

    const postInfo = await fetchPostInfo(postId);
    const workbook = buildWorkbook({ commentsResult: result, postInfo, sourceUrl, topLimit });
    const workbookPath = path.join(STATE_DIR, `comments_${postId}_workbook.json`);
    fs.writeFileSync(workbookPath, JSON.stringify(workbook, null, 2), 'utf8');

    const sheet = await exportWorkbook(workbook, {
      onProgress: async p => {
        if (p.action === 'append' && (p.start === 1 || p.start % 5000 === 1)) {
          await editMessage(chatId, statusMsg.message_id, [
            `Đang xuất Google Sheet postId=${postId}`,
            `- Tab: ${p.sheetName}`,
            `- Đã ghi tới dòng: ${p.totalRows}`,
          ].join('\n'));
        }
      },
    });

    const summary = { postId, title: workbook.title, topLimit, topLevelCount: result.topLevelCount, replyCount: result.replyCount, totalCommentCount: result.totalCommentCount, sheetUrl: sheet.url, outPath, workbookPath };    fs.writeFileSync(path.join(STATE_DIR, `comments_${postId}_summary.json`), JSON.stringify(summary, null, 2), 'utf8');

    await editMessage(chatId, statusMsg.message_id, [
      'Xong rồi ✅',
      `Post: ${postId}`,
      `Tổng comment/reply: ${result.totalCommentCount}`,
      `Comment gốc: ${result.topLevelCount}`,
      `Reply: ${result.replyCount}`,
      `Tabs: ${workbook.sheets.map(s => s.sheetName).join(', ')}`,
      '',
      sheet.url,
    ].join('\n'));
  } catch (error) {
    await editMessage(chatId, statusMsg.message_id, [
      'Lỗi khi lấy/xuất comment ❌',
      error.message,
      '',
      'Hãy update lại cookies và token rồi chạy get_cmt lại:',
      '- update_cookies',
      '- update_token',
    ].join('\n'));
  } finally {
    currentJob = null;
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  if (!isAuthorized(message)) {
    await sendMessage(chatId, 'Không có quyền dùng bot này.');
    return;
  }

  const text = normalizeText(message);
  if (!text && !message.document) return;
  if (text.startsWith('/') && !/^\/(start|help|status)\b/i.test(text)) return;

  if (await handleInteractiveState(chatId, message, text)) return;

  if (/^\/(start|help)\b/i.test(text) || /^fb\s+help$/i.test(text) || /^help$/i.test(text)) return sendMessage(chatId, helpText());
  if (/^\/status\b/i.test(text) || /^fb\s+status$/i.test(text) || /^status$/i.test(text)) return handleStatus(chatId);
  if (/^\/(check|checklive)\b/i.test(text) || /^fb\s+(check|checklive|check\s+cookie|check\s+cookies)$/i.test(text) || /^check(_?live)?$/i.test(text)) return handleCheck(chatId);
  if (isUpdateCookieCommand(text)) return handleUpdateCookies(chatId, message);
  if (isUpdateTokenCommand(text)) return handleUpdateToken(chatId, text);
  if (isGetCmtCommand(text)) return handleGetCmt(chatId, text);
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Thiếu TELEGRAM_BOT_TOKEN trong .env');
  storage.ensureDirs();
  console.log('Facebook Comment Telegram Bot started');
  while (true) {
    try {
      const updates = await getUpdates(updateOffset, 30);
      for (const update of updates) {
        updateOffset = update.update_id + 1;
        if (!update.message) continue;
        handleMessage(update.message).catch(error => {
          console.error(error);
          sendMessage(update.message.chat.id, `Lỗi: ${error.message}`).catch(() => null);
        });
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
