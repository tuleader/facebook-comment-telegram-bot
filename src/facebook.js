const fs = require('fs');
const path = require('path');
const { STATE_DIR, FB_API_VERSION, DEFAULT_LIMIT, DEFAULT_DELAY_MS } = require('./config');
const { getCookieHeader, getToken } = require('./storage');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeName(s) { return String(s || '').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120); }

function extractPostId(input) {
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

async function graphGet(edgeOrUrl, token, cookieHeader, fields, limit, apiVersion) {
  const url = buildUrl(edgeOrUrl, token, fields, limit, apiVersion);
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

async function fetchReplyPaging({ nextUrl, parentCommentId, comments, seen, stats, token, cookieHeader, limit, delayMs, apiVersion }) {
  let url = nextUrl;
  while (url) {
    const data = await graphGet(url, token, cookieHeader, null, limit, apiVersion);
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
    }
    url = data.paging && data.paging.next || null;
    if (url) await sleep(delayMs);
  }
}

async function harvestComments({ postId, limit = DEFAULT_LIMIT, delayMs = DEFAULT_DELAY_MS, apiVersion = FB_API_VERSION, outBase, onProgress }) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const token = getToken();
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
    const data = await graphGet(nextUrl, token, cookieHeader, fields, limit, apiVersion);
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

      if (c.comments && Array.isArray(c.comments.data)) {
        for (const reply of c.comments.data) {
          const item = normalizeComment(reply, 1, c.id || top.commentId);
          const rkey = item.commentId || `${item.parentCommentId}\n${item.author}\n${item.text}\n${item.createdTime}`;
          if (seen.has(rkey)) continue;
          seen.add(rkey);
          item.index = comments.length + 1;
          comments.push(item);
          stats.replyCount += 1;
        }
        if (c.comments.paging && c.comments.paging.next) {
          try {
            await fetchReplyPaging({ nextUrl: c.comments.paging.next, parentCommentId: c.id || top.commentId, comments, seen, stats, token, cookieHeader, limit, delayMs, apiVersion });
          } catch (error) {
            stats.errors.push({ parentCommentId: c.id || top.commentId, message: error.message, code: error.facebookError && error.facebookError.code });
          }
        }
      }
    }

    const hasNext = Boolean(data.paging && data.paging.next);
    const possibleCutoff = !hasNext && pageItems.length >= limit;
    const checkpoint = {
      sourcePostId: postId,
      startedAt,
      capturedAt: new Date().toISOString(),
      method: 'telegram_bot_graph_api_cookie',
      encoding: 'UTF-8',
      ...stats,
      totalCommentCount: comments.length,
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
        hasNextPage: hasNext,
        pageItems: pageItems.length,
        possiblePaginationCutoff: possibleCutoff,
      });
    }

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
    comments,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return { result, outPath, checkpointPath };
}

async function checkFacebookSession() {
  const token = getToken();
  const cookieHeader = getCookieHeader();
  const data = await graphGet('me', token, cookieHeader, 'id,name', 25, FB_API_VERSION);
  return { ok: true, id: data.id || null, name: data.name || null };
}

async function fetchPostInfo(postId) {
  const token = getToken();
  const cookieHeader = getCookieHeader();
  const fieldSets = [
    'id,from,description,title,created_time,permalink_url',
    'id,from,title,created_time,permalink_url',
    'id,from,created_time,permalink_url',
  ];
  let last = null;
  for (const fields of fieldSets) {
    const data = await graphGet(postId, token, cookieHeader, fields, 25, FB_API_VERSION).catch(err => ({ error: err.facebookError || { message: err.message } }));
    last = data;
    if (!data.error) {
      fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.json`), JSON.stringify(data, null, 2), 'utf8');
      return data;
    }
  }
  fs.writeFileSync(path.join(STATE_DIR, `post_info_${postId}.error.json`), JSON.stringify(last, null, 2), 'utf8');
  return { id: postId };
}

module.exports = { extractPostId, harvestComments, fetchPostInfo, checkFacebookSession };
