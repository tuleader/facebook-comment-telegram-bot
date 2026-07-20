const fs = require('fs');
const path = require('path');
const { AUTHORIZED_USER_ID, STATE_DIR, TELEGRAM_BOT_TOKEN, SHEETS_WEBHOOK_URL, SHEETS_SECRET_TOKEN, DEFAULT_LIMIT, DEFAULT_DELAY_MS, AUTO_TOKEN_REFRESH } = require('./config');
const { sendMessage, editMessage, getUpdates, downloadFile } = require('./telegram');
const storage = require('./storage');
const { extractPostId, resolveInput, harvestComments, fetchPostInfo, checkFacebookSession, classifyFbError } = require('./facebook');
const { buildWorkbook } = require('./workbook');
const { exportWorkbook } = require('./sheets');
const { ensureFreshToken } = require('./tokenHelper');

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
    'Facebook Comment Export Bot (v2.0 - Chromium Auto Token)',
    '',
    'Lệnh hội thoại:',
    'get_cmt / fb get_cmt / fb lấy cmt',
    'get_cmt <URL> top 10  -> thêm tab top_10_tuong_tac',
    'get_cmt <URL> --free-limit 200  -> giới hạn số dòng crawl',
    'update_cookies / fb update cookies -> nạp cookies cho bot',
    'refresh_token / fb refresh token  -> chủ động mở Chromium trích xuất token',
    'fb status / fb check',
    '',
    'Tính năng Tự Động Lấy Token (Chromium):',
    `- Trạng thái Auto Refresh: ${AUTO_TOKEN_REFRESH ? 'BẬT ✅' : 'TẮT ❌'}`,
    '- Bạn CHỈ CẦN NẠP COOKIES (`update_cookies`), bot sẽ tự động mở AdsManager bằng Chromium ngầm để lấy và làm mới access token khi cần.',
    '',
    'Flow get_cmt:',
    '1. Bot kiểm tra cookie',
    '2. Thiếu cookie thì yêu cầu gửi file cookie JSON hoặc dán cookie text (`update_cookies`)',
    '3. Đã có cookie -> yêu cầu gửi URL bài viết (hoặc crawl luôn nếu gửi kèm URL)',
    '4. Bot tự trích xuất token từ AdsManager, crawl comment và xuất Google Sheet',
    '',
    'Hỗ trợ URL:',
    '- Link post, video, reel, photo, permalink',
    '- Share URL (facebook.com/share/... -> auto follow)',
    '- pfbid... (text post ID -> auto scrap HTML)',
    '- Numeric post ID trực tiếp',
    '',
    'Sheet mặc định:',
    '- tat_ca_cmt (có Loại bình luận, ID_Parent, Link bài viết)',
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
function isRefreshTokenCommand(text) {
  return /^(refresh_token|fb\s+refresh\s+token|fb\s+(lấy|lay)\s+token)$/i.test(text);
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
function parseMaxRows(text) {
  const s = String(text || '');
  const patterns = [
    /(?:^|\s)--max-rows(?:=|\s+)(\d{1,7})(?=\s|$)/i,
    /(?:^|\s)--free-limit(?:=|\s+)(\d{1,7})(?=\s|$)/i,
    /(?:^|\s)--limit-rows(?:=|\s+)(\d{1,7})(?=\s|$)/i,
  ];
  for (const re of patterns) {
    const match = s.match(re);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) return Math.min(n, 1000000);
  }
  return null;
}
function stripOptionsFromSource(text) {
  return String(text || '')
    .replace(/(?:^|\s)--top(?:=|\s+)\d{1,4}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)top\s*\d{1,4}(?=\s|$)/ig, ' ')
    .replace(/(?:lấy|lay)\s+top\s*\d{1,4}/ig, ' ')
    .replace(/(?:^|\s)--max-rows(?:=|\s+)\d{1,7}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)--free-limit(?:=|\s+)\d{1,7}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)--limit-rows(?:=|\s+)\d{1,7}(?=\s|$)/ig, ' ')
    .trim();
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
    `- Token (đệm disk): ${st.tokenOk ? 'OK' : 'CHƯA TRÍCH XUẤT (bot sẽ tự lấy từ cookie)'}${st.tokenOk ? ` (${st.tokenLength} chars)` : ''}`,
    `- Google webhook: ${SHEETS_WEBHOOK_URL && SHEETS_SECRET_TOKEN ? 'OK' : 'CHƯA CẤU HÌNH'}`,
    `- Auto Token Refresh (Chromium): ${AUTO_TOKEN_REFRESH ? 'BẬT ✅' : 'TẮT ❌'}`,
    `- Job đang chạy: ${currentJob ? currentJob : 'không'}`,
    `- Đang chờ: ${getSession(chatId)?.step || 'không'}`,
  ].join('\n'));
}

async function handleRefreshToken(chatId) {
  if (currentJob) {
    await sendMessage(chatId, `Đang có job chạy: ${currentJob}. Đợi job xong rồi thử lại nhé.`);
    return;
  }
  const st = storage.status();
  if (!st.cookieOk) {
    await sendMessage(chatId, 'Chưa có cookies (facebook_cookie.json), không thể tự lấy token. Hãy gửi update_cookies trước.');
    return;
  }
  const statusMsg = await sendMessage(chatId, '⏳ Đang khởi động Chromium để tự động lấy token từ AdsManager...');
  try {
    const newToken = await ensureFreshToken({
      forceRefresh: true,
      onProgress: async info => {
        await editMessage(chatId, statusMsg.message_id, `⏳ ${info.message}`).catch(() => null);
      },
    });
    await editMessage(chatId, statusMsg.message_id, `✅ Tự lấy và cập nhật token mới thành công!\n- Token prefix: ${newToken.slice(0, 8)}...\n- Độ dài: ${newToken.length}`).catch(() => null);
  } catch (error) {
    const errorMsg = error.isCheckpoint
      ? `🔒 Account Facebook bị checkpoint/lock!\nChi tiết: ${error.message}\n\nHãy vào lại nick Facebook bằng trình duyệt để mở khóa rồi dán lại cookies.`
      : `❌ Lấy token tự động thất bại: ${error.message}\n\nHãy kiểm tra cookies hoặc gửi token thủ công qua lệnh update_token.`;
    await editMessage(chatId, statusMsg.message_id, errorMsg).catch(() => null);
  }
}

async function handleCheck(chatId) {
  const st = storage.status();
  if (!st.cookieOk) {
    await sendMessage(chatId, [
      'Chưa có cookies để check live:',
      `- Cookie: CHƯA CÓ`,
      '',
      'Gửi update_cookies trước nhé.',
    ].join('\n'));
    return;
  }
  const statusMsg = await sendMessage(chatId, 'Đang kiểm tra cookie (và tự động trích xuất token nếu cần)...');
  try {
    const me = await checkFacebookSession({
      onTokenRefresh: async info => {
        await editMessage(chatId, statusMsg.message_id, `⏳ ${info.message}`).catch(() => null);
      },
    });
    await editMessage(chatId, statusMsg.message_id, `Cookie + token còn sống ✅\nFacebook account: ${me.name || 'unknown'} (${me.id || 'unknown'})`).catch(() => null);
  } catch (error) {
    const classified = classifyFbError(error);
    await editMessage(chatId, statusMsg.message_id, [
      'Cookie/token có vấn đề hoặc đã hết hạn ❌',
      `Loại lỗi: ${classified.type}`,
      classified.message,
      '',
      'Hãy gửi lại:',
      '- update_cookies (để nạp cookies mới cho bot)',
      '- refresh_token (để thử chủ động lấy lại token qua Chromium)',
    ].join('\n')).catch(() => null);
  }
}

async function askNextForGetCmt(chatId) {
  const st = storage.status();
  if (!st.cookieOk) {
    setSession(chatId, 'awaiting_cookie_for_get');
    await sendMessage(chatId, 'Chưa có cookies. Gửi file cookie JSON hoặc dán cookie header text dạng:\nsb=...; datr=...; c_user=...; xs=...');
    return;
  }
  setSession(chatId, 'awaiting_url_for_get');
  await sendMessage(chatId, 'Đã có cookies ✅\nGửi URL bài viết/live/reel cần lấy comment.\n(Bot sẽ tự động trích xuất và làm mới access token từ AdsManager bằng Chromium)');
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
  await sendMessage(chatId, `Đã lưu cookies ✅\n- Số cookie: ${result.cookieCount}\n- c_user: ${result.c_user}\n\n👉 Bạn có thể gửi lệnh 'get_cmt <URL>' ngay bây giờ (bot sẽ tự động trích xuất access token từ AdsManager qua Chromium).`);
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

  if (!st.cookieOk) {
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
  const maxRows = parseMaxRows(sourceUrl);
  const cleanedUrl = stripOptionsFromSource(sourceUrl);

  // Resolve the Facebook input (handles pfbid, share URLs, etc.)
  let postId;
  let canonicalUrl = cleanedUrl;
  let sourceType = 'unknown';
  try {
    const resolved = await resolveInput(cleanedUrl);
    if (resolved.ok) {
      postId = resolved.targetId;
      canonicalUrl = resolved.canonicalUrl || cleanedUrl;
      sourceType = resolved.sourceType || 'unknown';
    } else {
      // Fallback to legacy extraction
      postId = extractPostId(cleanedUrl);
    }
  } catch (_) {
    postId = extractPostId(cleanedUrl);
  }

  currentJob = postId;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const statusMsg = await sendMessage(chatId, [
    `Bắt đầu lấy comment postId=${postId}`,
    sourceType !== 'unknown' ? `Loại: ${sourceType}` : '',
    topLimit ? `Sẽ thêm tab top_${topLimit}_tuong_tac` : '',
    maxRows ? `Giới hạn: ${maxRows} dòng` : '',
    'Đang crawl...',
  ].filter(Boolean).join('\n'));
  let lastProgressAt = 0;

  try {
    const { result, outPath } = await harvestComments({
      postId,
      maxRows,
      onTokenRefresh: async info => {
        await editMessage(chatId, statusMsg.message_id, [
          `⏳ ${info.message}`,
          `Đang xử lý postId=${postId}`,
        ].join('\n')).catch(() => null);
      },
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
          p.stoppedAtLimit ? `⚠️ Đã đạt giới hạn ${p.maxRows} dòng.` : '',
          p.possiblePaginationCutoff ? '⚠️ Có dấu hiệu bị cắt pagination sớm.' : '',
        ].filter(Boolean).join('\n')).catch(() => null);
      },
    });

    await editMessage(chatId, statusMsg.message_id, [
      `Crawl xong postId=${postId}`,
      `- Comment gốc: ${result.topLevelCount}`,
      `- Reply: ${result.replyCount}`,
      `- Tổng: ${result.totalCommentCount}`,
      result.stoppedAtLimit ? `- Đã dừng theo giới hạn: ${result.maxRows} dòng` : '',
      'Đang xuất Google Sheet...',
    ].filter(Boolean).join('\n')).catch(() => null);

    const postInfo = await fetchPostInfo(postId, { sourceUrl: canonicalUrl });
    const workbook = buildWorkbook({ commentsResult: result, postInfo, sourceUrl: canonicalUrl, topLimit });
    const workbookPath = path.join(STATE_DIR, `comments_${postId}_workbook.json`);
    fs.writeFileSync(workbookPath, JSON.stringify(workbook, null, 2), 'utf8');

    const sheet = await exportWorkbook(workbook, {
      onProgress: async p => {
        if (p.action === 'append' && (p.start === 1 || p.start % 5000 === 1)) {
          await editMessage(chatId, statusMsg.message_id, [
            `Đang xuất Google Sheet postId=${postId}`,
            `- Tab: ${p.sheetName}`,
            `- Đã ghi tới dòng: ${p.totalRows}`,
          ].join('\n')).catch(() => null);
        }
      },
    });

    const summary = { postId, title: workbook.title, topLimit, maxRows, stoppedAtLimit: result.stoppedAtLimit, topLevelCount: result.topLevelCount, replyCount: result.replyCount, totalCommentCount: result.totalCommentCount, sheetUrl: sheet.url, outPath, workbookPath };
    fs.writeFileSync(path.join(STATE_DIR, `comments_${postId}_summary.json`), JSON.stringify(summary, null, 2), 'utf8');

    await editMessage(chatId, statusMsg.message_id, [
      'Xong rồi ✅',
      `Post: ${postId}`,
      `Content: ${workbook.title}`,
      `Tổng comment/reply: ${result.totalCommentCount}`,
      `Comment gốc: ${result.topLevelCount}`,
      `Reply: ${result.replyCount}`,
      result.stoppedAtLimit ? `Đã dừng theo giới hạn: ${result.maxRows} dòng` : '',
      `Tabs: ${workbook.sheets.map(s => s.sheetName).join(', ')}`,
      '',
      sheet.url,
    ].filter(Boolean).join('\n')).catch(() => null);
  } catch (error) {
    const classified = classifyFbError(error);
    const errorLines = [
      'Lỗi khi lấy/xuất comment ❌',
      `Loại lỗi: ${classified.type}`,
      classified.message,
    ];

    if (classified.type === 'checkpoint') {
      errorLines.push('', '🔒 Account bị checkpoint! Hãy vào lại Facebook bằng trình duyệt để xác minh rồi gửi lại update_cookies.');
    } else if (classified.type === 'rate_limit') {
      errorLines.push('', 'Đợi vài phút rồi thử lại lệnh get_cmt.');
    } else if (classified.type === 'token_expired' || classified.type === 'token_invalid') {
      errorLines.push('', 'Hãy gửi update_cookies mới hoặc gõ lệnh refresh_token.');
    } else {
      errorLines.push('', 'Hãy nạp lại cookies mới cho bot:', '- update_cookies');
    }

    await editMessage(chatId, statusMsg.message_id, errorLines.join('\n')).catch(() => null);
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
  if (text.startsWith('/') && !/^\/(start|help|status|refresh_token)\b/i.test(text)) return;

  if (await handleInteractiveState(chatId, message, text)) return;

  if (/^\/(start|help)\b/i.test(text) || /^fb\s+help$/i.test(text) || /^help$/i.test(text)) return sendMessage(chatId, helpText());
  if (/^\/status\b/i.test(text) || /^fb\s+status$/i.test(text) || /^status$/i.test(text)) return handleStatus(chatId);
  if (/^\/(check|checklive)\b/i.test(text) || /^fb\s+(check|checklive|check\s+cookie|check\s+cookies)$/i.test(text) || /^check(_?live)?$/i.test(text)) return handleCheck(chatId);
  if (isRefreshTokenCommand(text) || /^\/refresh_token\b/i.test(text)) return handleRefreshToken(chatId);
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
