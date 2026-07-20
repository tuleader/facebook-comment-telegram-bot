const fs = require('fs');
const path = require('path');
const { STATE_DIR, FB_API_VERSION, DEFAULT_LIMIT, DEFAULT_DELAY_MS, AUTO_TOKEN_REFRESH } = require('./config');
const { getCookieHeader, getToken } = require('./storage');
const { resolveFacebookSource, resolveFacebookInput } = require('./sourceResolver');
const { ensureFreshToken } = require('./tokenHelper');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120); }

/**
 * Extract a Graph-API-usable post ID from any Facebook input (URL, ID, pfbid).
 * Offline-only version — no network requests. Suitable for quick parsing.
 */
function extractPostId(input) {
  const resolved = resolveFacebookSource(input);
  if (resolved.ok) return resolved.targetId;

  // Fallback: legacy regex extraction
  const raw = String(input || '').trim();
  if (/^\d{8,}$/.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch (_) { url = null; }
  if (url) {
    for (const key of ['v', 'story_fbid', 'fbid']) {
      const value = url.searchParams.get(key);
      if (value && /^\d{8,}$/.test(value)) return value;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (['videos', 'posts', 'reel', 'photo', 'permalink'].includes(parts[i]) && /^\d{8,}$/.test(parts[i + 1] || '')) {
        return parts[i + 1];
      }
    }
    const nums = parts.concat([...url.searchParams.values()]).flatMap(v => String(v).match(/\d{8,}/g) || []);
    if (nums.length) return nums[nums.length - 1];
  }
  const match = raw.match(/\d{8,}/g);
  if (match && match.length) return match[match.length - 1];
  throw new Error('Không tìm được postId từ link Facebook.');
}

/**
 * Resolve Facebook input with network requests (for pfbid & share URLs).
 * Returns { ok, sourceType, targetId, canonicalUrl, inputKind, reason }.
 */
async function resolveInput(input) {
  return resolveFacebookInput(input);
}

function buildUrl(edgeOrUrl, token, fields, limit, apiVersion) {
  const url = edgeOrUrl.startsWith('http')
    ? new URL(edgeOrUrl)
    : new URL(`https://graph.facebook.com/${apiVersion}/${edgeOrUrl}`);

  url.searchParams.set('access_token', token);
  if (fields && !url.searchParams.has('fields')) url.searchParams.set('fields', fields);
  if (!url.searchParams.has('limit')) url.searchParams.set('limit', String(limit));
  url.searchParams.set('debug', 'all');
  url.searchParams.set('format', 'json');
  url.searchParams.set('method', 'get');
  url.searchParams.set('origin_graph_explorer', '1');
  url.searchParams.set('pretty', '0');
  url.searchParams.set('suppress_http_code', '1');
  url.searchParams.set('transport', 'cors');
  return url;
}

/**
 * Classify a Facebook API error for better user-facing messages.
 */
function classifyFbError(error) {
  if (error.isCheckpoint) return { type: 'checkpoint', message: error.message };
  const fbErr = error.facebookError || {};
  const code = fbErr.code;
  if (code === 368) return { type: 'rate_limit', message: 'Bị rate limit (dùng quá nhanh). Đợi vài phút rồi thử lại.' };
  if (code === 190) return { type: 'token_expired', message: 'Token đã hết hạn. Gửi update_cookies hoặc refresh_token để bot lấy lại token.' };
  if (code === 102) return { type: 'token_invalid', message: 'Token không hợp lệ. Gửi update_cookies hoặc refresh_token để bot lấy lại token.' };
  if (code === 100) return { type: 'invalid_param', message: `Tham số không hợp lệ: ${fbErr.message || 'unknown'}` };
  if (error.httpStatus === 400) return { type: 'token_expired', message: 'HTTP 400 – token có thể đã hết hạn. Gửi refresh_token hoặc update_cookies.' };
  if (error.httpStatus === 401) return { type: 'unauthorized', message: 'Không có quyền truy cập. Kiểm tra lại cookies/tài khoản.' };
  if (error.httpStatus === 429) return { type: 'rate_limit', message: 'HTTP 429 – rate limited. Đợi rồi thử lại.' };
  return { type: 'unknown', message: fbErr.message || error.message || 'Lỗi không xác định.' };
}

async function getActiveToken({ onProgress, forceRefresh = false } = {}) {
  let token = null;
  if (!forceRefresh) {
    try { token = getToken({ allowEmpty: true }); } catch (_) {}
  }
  if (token && token.length >= 40) return token;

  if (AUTO_TOKEN_REFRESH) {
    console.log('[getActiveToken] No token found or forceRefresh requested, auto-extracting via Chromium...');
    return await ensureFreshToken({ forceRefresh: true, onProgress });
  }

  throw new Error('Chưa có token Facebook. Hãy gửi update_cookies để bot tự lấy token.');
}

async function graphGet(edgeOrUrl, token, cookieHeader, fields, limit, apiVersion, options = {}) {
  const attemptGet = async (tokenToUse) => {
    const url = buildUrl(edgeOrUrl, tokenToUse, fields, limit, apiVersion);
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        Origin: 'https://developers.facebook.com',
        Referer: 'https://developers.facebook.com/tools/explorer/',
      },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (data && data.error) {
      const err = new Error(data.error.message || 'Facebook API error');
      err.facebookError = data.error;
      err.httpStatus = res.status;
      throw err;
    }
    return data;
  };

  try {
    return await attemptGet(token);
  } catch (error) {
    // Auto-retry & auto-refresh: re-read token from file or trigger Chromium extraction
    const isTokenError =
      (error.facebookError && (error.facebookError.code === 190 || error.facebookError.code === 102)) ||
      error.httpStatus === 400 || error.httpStatus === 401;

    if (isTokenError && !options._retriedToken) {
      try {
        let freshToken = null;
        try { freshToken = getToken({ allowEmpty: true }); } catch (_) {}

        if (freshToken && freshToken !== token) {
          console.log(`[graphGet] Token error (${error.message}), retrying with fresh disk token...`);
          return await graphGet(edgeOrUrl, freshToken, cookieHeader, fields, limit, apiVersion, { ...options, _retriedToken: true });
        }

        if (AUTO_TOKEN_REFRESH) {
          console.log(`[graphGet] Token error (${error.message}), triggering auto token refresh via Chromium...`);
          const newToken = await ensureFreshToken({ forceRefresh: true, onProgress: options.onTokenRefresh });
          return await graphGet(edgeOrUrl, newToken, cookieHeader, fields, limit, apiVersion, { ...options, _retriedToken: true });
        }
      } catch (refreshErr) {
        console.error('[graphGet] Auto token refresh failed:', refreshErr.message);
        throw refreshErr.isCheckpoint ? refreshErr : error;
      }
    }
    throw error;
  }
}

function normalizeComment(comment, depth, parentCommentId = null) {
  return {
    commentId: comment.id || null,
    authorId: comment.from && comment.from.id || null,
    author: comment.from && comment.from.name || null,
    text: comment.message || '',
    createdTime: comment.created_time || null,
    parentCommentId,
    depth,
  };
}

function shouldStopCollection(rowCount, maxRows) {
  return maxRows !== null && maxRows !== undefined && Number(maxRows) > 0 && rowCount >= Number(maxRows);
}

async function fetchReplyPaging({ nextUrl, parentCommentId, comments, seen, stats, token, cookieHeader, limit, delayMs, apiVersion, maxRows, options = {} }) {
  let url = nextUrl;
  let currentToken = token;
  while (url && !shouldStopCollection(comments.length, maxRows)) {
    try { const diskToken = getToken({ allowEmpty: true }); if (diskToken) currentToken = diskToken; } catch (_) {}
    const data = await graphGet(url, currentToken, cookieHeader, null, limit, apiVersion, options);
    stats.replyPages += 1;
    const replies = Array.isArray(data.data) ? data.data : [];
    for (const reply of replies) {
      const item = normalizeComment(reply, 1, parentCommentId);
      const key = item.commentId || `${item.parentCommentId}\n${item.author}\n${item.text}\n${item.createdTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      item.index = comments.length + 1;
      comments.push(item);
      stats.replyCount += 1;
      if (shouldStopCollection(comments.length, maxRows)) break;
    }
    url = data.paging && data.paging.next || null;
    if (url) await sleep(delayMs);
  }
}

async function harvestComments({ postId, limit = DEFAULT_LIMIT, delayMs = DEFAULT_DELAY_MS, apiVersion = FB_API_VERSION, outBase, maxRows = null, onProgress, onTokenRefresh }) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let currentToken = await getActiveToken({ onProgress: onTokenRefresh });
  const cookieHeader = getCookieHeader();
  const base = outBase || `comments_${postId}`;
  const outPath = path.join(STATE_DIR, `${safeName(base)}.json`);
  const checkpointPath = path.join(STATE_DIR, `${safeName(base)}.checkpoint.json`);
  const fields = 'id,created_time,from,message,comments.limit(200){id,created_time,from,message}';

  const comments = [];
  const seen = new Set();
  const stats = { topPages: 0, replyPages: 0, topLevelCount: 0, replyCount: 0, errors: [] };
  const startedAt = new Date().toISOString();
  let nextUrl = `${encodeURIComponent(postId)}/comments`;

  while (nextUrl) {
    try { const diskToken = getToken({ allowEmpty: true }); if (diskToken) currentToken = diskToken; } catch (_) {}
    const data = await graphGet(nextUrl, currentToken, cookieHeader, fields, limit, apiVersion, { onTokenRefresh });
    stats.topPages += 1;
    const pageItems = Array.isArray(data.data) ? data.data : [];

    for (const c of pageItems) {
      const top = normalizeComment(c, 0, null);
      const key = top.commentId || `${top.author}\n${top.text}\n${top.createdTime}`;
      if (!seen.has(key)) {
        seen.add(key);
        top.index = comments.length + 1;
        comments.push(top);
        stats.topLevelCount += 1;
      }
      if (shouldStopCollection(comments.length, maxRows)) break;

      if (c.comments && Array.isArray(c.comments.data)) {
        for (const reply of c.comments.data) {
          const item = normalizeComment(reply, 1, c.id || top.commentId);
          const rkey = item.commentId || `${item.parentCommentId}\n${item.author}\n${item.text}\n${item.createdTime}`;
          if (seen.has(rkey)) continue;
          seen.add(rkey);
          item.index = comments.length + 1;
          comments.push(item);
          stats.replyCount += 1;
          if (shouldStopCollection(comments.length, maxRows)) break;
        }
        if (shouldStopCollection(comments.length, maxRows)) break;
        if (c.comments.paging && c.comments.paging.next) {
          try {
            await fetchReplyPaging({ nextUrl: c.comments.paging.next, parentCommentId: c.id || top.commentId, comments, seen, stats, token: currentToken, cookieHeader, limit, delayMs, apiVersion, maxRows, options: { onTokenRefresh } });
          } catch (error) {
            stats.errors.push({ parentCommentId: c.id || top.commentId, message: error.message, code: error.facebookError && error.facebookError.code });
          }
        }
      }
      if (shouldStopCollection(comments.length, maxRows)) break;
    }

    const hasNext = Boolean(data.paging && data.paging.next);
    const stoppedAtLimit = shouldStopCollection(comments.length, maxRows);
    const possibleCutoff = !hasNext && pageItems.length >= limit;
    const checkpoint = {
      sourcePostId: postId,
      startedAt,
      capturedAt: new Date().toISOString(),
      method: 'telegram_bot_graph_api_cookie',
      encoding: 'UTF-8',
      ...stats,
      totalCommentCount: comments.length,
      maxRows,
      stoppedAtLimit,
      possiblePaginationCutoff: possibleCutoff,
      comments,
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');

    if (onProgress) {
      await onProgress({
        topPages: stats.topPages,
        topLevelCount: stats.topLevelCount,
        replyCount: stats.replyCount,
        totalCommentCount: comments.length,
        hasNextPage: hasNext && !stoppedAtLimit,
        pageItems: pageItems.length,
        maxRows,
        stoppedAtLimit,
        possiblePaginationCutoff: possibleCutoff,
      });
    }

    if (stoppedAtLimit) break;
    nextUrl = hasNext ? data.paging.next : null;
    if (nextUrl) await sleep(delayMs);
  }

  const result = {
    sourcePostId: postId,
    startedAt,
    capturedAt: new Date().toISOString(),
    method: 'telegram_bot_graph_api_cookie',
    encoding: 'UTF-8',
    ...stats,
    totalCommentCount: comments.length,
    maxRows,
    stoppedAtLimit: shouldStopCollection(comments.length, maxRows),
    comments,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return { result, outPath, checkpointPath };
}

async function checkFacebookSession(options = {}) {
  const token = await getActiveToken({ onProgress: options.onTokenRefresh });
  const cookieHeader = getCookieHeader();
  const data = await graphGet('me', token, cookieHeader, 'id,name', 25, FB_API_VERSION, options);
  return { ok: true, id: data.id || null, name: data.name || null };
}

async function fetchPostInfo(postId, options = {}) {
  const token = await getActiveToken({ onProgress: options.onTokenRefresh });
  const cookieHeader = getCookieHeader();
  const fieldSets = [
    'id,from,message,description,title,created_time,permalink_url',
    'id,from,title,created_time,permalink_url',
    'id,from,created_time,permalink_url',
  ];
  const shortId = postId.includes('_') ? postId.split('_')[1] : null;
  const ownerId = postId.includes('_') ? postId.split('_')[0] : null;
  const candidateIds = Array.from(new Set([postId, shortId, ownerId].filter(Boolean)));

  let last = null;
  for (const id of candidateIds) {
    for (const fields of fieldSets) {
      const data = await graphGet(id, token, cookieHeader, fields, 25, FB_API_VERSION, options).catch(err => ({ error: err.facebookError || { message: err.message } }));
      last = data;
      if (!data.error && (data.message || data.description || data.title || data.from)) {
        const info = { ...data, id: postId, sourcePostId: postId };
        fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.json`), JSON.stringify(info, null, 2), 'utf8');
        return info;
      }
    }
  }

  if (shortId) {
    for (const fields of fieldSets) {
      const batchData = await graphGet(`?ids=${postId},${shortId}`, token, cookieHeader, fields, 25, FB_API_VERSION, options).catch(() => null);
      if (batchData && !batchData.error && typeof batchData === 'object') {
        const found = batchData[postId] || batchData[shortId];
        if (found && !found.error && (found.message || found.description || found.title || found.from)) {
          const info = { ...found, id: postId, sourcePostId: postId };
          fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.json`), JSON.stringify(info, null, 2), 'utf8');
          return info;
        }
      }
    }
  }

  let fallbackInfo = { id: postId };
  try {
    const urlToFetch = options.sourceUrl || (shortId && ownerId ? `https://www.facebook.com/${ownerId}/posts/${shortId}` : `https://www.facebook.com/${postId}`);
    const res = await fetch(urlToFetch, {
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);

    let scrapedTitle = ogTitleMatch?.[1] || titleMatch?.[1] || '';
    let scrapedDesc = ogDescMatch?.[1] || '';
    if (scrapedTitle) {
      scrapedTitle = scrapedTitle.replace(/\s*\|.*$/, '').replace(/^[^-]+-\s*/, '').trim();
    }
    if (scrapedDesc || scrapedTitle) {
      fallbackInfo = {
        id: postId,
        title: scrapedTitle || scrapedDesc,
        description: scrapedDesc,
        message: scrapedDesc || scrapedTitle,
        permalink_url: res.url || urlToFetch,
        from: { name: (titleMatch?.[1] || '').split('-')[0].trim() || '' },
      };
      fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.json`), JSON.stringify(fallbackInfo, null, 2), 'utf8');
      return fallbackInfo;
    }
  } catch (_) {}

  if (last && !last.error) return { ...last, id: postId };
  fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.error.json`), JSON.stringify(last, null, 2), 'utf8');
  return fallbackInfo;
}

module.exports = { extractPostId, resolveInput, harvestComments, fetchPostInfo, checkFacebookSession, classifyFbError, getActiveToken };
