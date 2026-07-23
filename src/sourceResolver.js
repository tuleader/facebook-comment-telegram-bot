/**
 * sourceResolver.js – Ported from tool-fb/src/commentExport/sourceResolver.js
 *
 * Resolves many flavours of Facebook URL / ID input into a canonical
 * Graph-API-friendly post / video target ID.
 *
 * Supports:
 *  - Numeric post IDs (direct)
 *  - pfbid… text post IDs (resolved via HTML scraping)
 *  - /videos/ID, /reel/ID, ?v=ID
 *  - ?story_fbid=ID&id=OWNER
 *  - /posts/pfbid…, /posts/ID
 *  - /photos/…/ID, /permalink/ID
 *  - /share/… redirect URLs
 */

const { getCookieHeader } = require('./storage');

const FACEBOOK_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com', 'fb.watch'
]);
const TEXT_POST_ID_PATTERN = /^pfbid[0-9A-Za-z]+$/;
const NUMERIC_GRAPH_TARGET_PATTERN = /^\d{8,}(?:_\d{8,})?$/;
const NUMERIC_POST_ID_PATTERN = /\d{8,}/;

const POST_ID_PATTERNS = [
  /"top_level_post_id"\s*:\s*"(\d{8,})"/,
  /"story_fbid"\s*:\s*\[\s*"(\d{8,})"\s*\]/,
  /"story_fbid"\s*:\s*"(\d{8,})"/,
  /"post_id"\s*:\s*"(\d{8,})"/,
  /\\"post_id\\"\s*:\s*\\"(\d{8,})\\"/,
  /"subscription_target_id"\s*:\s*"(\d{8,})"/,
];

const OWNER_ID_PATTERNS = [
  /"page_id"\s*:\s*"(\d{8,})"/,
  /"content_owner_id_new"\s*:\s*"(\d{8,})"/,
  /"owning_profile_id"\s*:\s*"(\d{8,})"/,
  /\\"page_id\\"\s*:\s*\\"(\d{8,})\\"/,
  /\\"content_owner_id_new\\"\s*:\s*\\"(\d{8,})\\"/,
  /\\"owning_profile_id\\"\s*:\s*\\"(\d{8,})\\"/,
];

function isFacebookShareUrl(input) {
  try {
    const url = new URL(String(input || '').trim());
    if (url.hostname === 'fb.watch') return true;
    return FACEBOOK_HOSTS.has(url.hostname) && url.pathname.startsWith('/share/');
  } catch (_) {
    return false;
  }
}

function extractPostIdFromText(text) {
  for (const pattern of POST_ID_PATTERNS) {
    const match = String(text || '').match(pattern);
    if (match?.[1] && NUMERIC_POST_ID_PATTERN.test(match[1])) return match[1];
  }
  return null;
}

function extractOwnerIdFromText(text) {
  for (const pattern of OWNER_ID_PATTERNS) {
    const match = String(text || '').match(pattern);
    if (match?.[1] && NUMERIC_POST_ID_PATTERN.test(match[1])) return match[1];
  }
  return null;
}

function extractCanonicalPostIdFromHtml(html, pfbid) {
  const buildTargetId = text => {
    const postId = extractPostIdFromText(text);
    if (!postId) return null;
    const ownerId = extractOwnerIdFromText(text);
    return ownerId ? `${ownerId}_${postId}` : postId;
  };

  if (pfbid) {
    const index = String(html || '').indexOf(pfbid);
    if (index >= 0) {
      const windowStart = Math.max(0, index - 50000);
      const windowEnd = Math.min(html.length, index + 1500000);
      const nearby = buildTargetId(html.slice(windowStart, windowEnd));
      if (nearby) return nearby;
    }
  }

  return buildTargetId(html);
}

/**
 * Resolve a Facebook input (URL or ID) purely from its string form.
 * No network requests. Returns { ok, sourceType, targetId, canonicalUrl, inputKind, reason }.
 */
function resolveFacebookSource(input) {
  const value = String(input || '').trim();
  if (!value) return { ok: false, reason: 'EMPTY_INPUT' };
  if (NUMERIC_GRAPH_TARGET_PATTERN.test(value)) return { ok: true, sourceType: 'unknown', targetId: value, inputKind: 'direct_id' };
  if (TEXT_POST_ID_PATTERN.test(value)) return { ok: true, sourceType: 'post', targetId: value, inputKind: 'direct_id' };

  let url;
  try { url = new URL(value); } catch (_) { return { ok: false, reason: 'UNSUPPORTED_URL' }; }
  if (!FACEBOOK_HOSTS.has(url.hostname)) return { ok: false, reason: 'UNSUPPORTED_URL' };
  
  if (url.hostname === 'fb.watch') return { ok: false, reason: 'TARGET_ID_NOT_FOUND' };
  if (url.pathname.startsWith('/share/')) return { ok: false, reason: 'TARGET_ID_NOT_FOUND' };

  const videoMatch = url.pathname.match(/\/videos\/(\d+)/);
  if (videoMatch?.[1]) return { ok: true, sourceType: 'video', targetId: videoMatch[1], canonicalUrl: url.href, inputKind: 'canonical_url' };

  const reelMatch = url.pathname.match(/\/reel\/(\d+)/);
  if (reelMatch?.[1]) return { ok: true, sourceType: 'video', targetId: reelMatch[1], canonicalUrl: url.href, inputKind: 'canonical_url' };

  const watchId = url.searchParams.get('v');
  if (watchId && /^\d+$/.test(watchId)) return { ok: true, sourceType: 'video', targetId: watchId, canonicalUrl: url.href, inputKind: 'canonical_url' };

  const storyId = url.searchParams.get('story_fbid') || url.searchParams.get('fbid');
  if (storyId && /^\d+$/.test(storyId)) {
    const ownerId = url.searchParams.get('id');
    const targetId = ownerId && /^\d+$/.test(ownerId) ? `${ownerId}_${storyId}` : storyId;
    return { ok: true, sourceType: 'post', targetId, canonicalUrl: url.href, inputKind: 'canonical_url' };
  }

  const postMatch = url.pathname.match(/\/posts\/([^/?#]+)/);
  if (postMatch?.[1]) return { ok: true, sourceType: 'post', targetId: postMatch[1], canonicalUrl: url.href, inputKind: 'canonical_url' };

  const photoMatch = url.pathname.match(/\/photos\/(?:[^/]+\/)?(\d+)/);
  if (photoMatch?.[1]) return { ok: true, sourceType: 'post', targetId: photoMatch[1], canonicalUrl: url.href, inputKind: 'canonical_url' };

  const permalinkMatch = url.pathname.match(/\/permalink\/(\d+)/);
  if (permalinkMatch?.[1]) return { ok: true, sourceType: 'post', targetId: permalinkMatch[1], canonicalUrl: url.href, inputKind: 'canonical_url' };

  return { ok: false, reason: 'TARGET_ID_NOT_FOUND' };
}

async function fetchHtml(input, cookieHeader) {
  const headers = {
    accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetch(input, { method: 'GET', redirect: 'follow', headers });
  const html = await response.text();
  return { url: response.url || input, html };
}

async function resolvePfbidPostUrl(input, fallbackResult, cookieHeader) {
  if (!(fallbackResult.ok && fallbackResult.sourceType === 'post' && fallbackResult.inputKind === 'canonical_url' && TEXT_POST_ID_PATTERN.test(fallbackResult.targetId))) {
    return fallbackResult;
  }

  const response = await fetchHtml(input, cookieHeader);
  const targetId = extractCanonicalPostIdFromHtml(response.html, fallbackResult.targetId);
  if (!targetId) return fallbackResult;
  return { ok: true, sourceType: 'post', targetId, canonicalUrl: response.url || fallbackResult.canonicalUrl, inputKind: 'canonical_url' };
}

async function resolveShareUrl(input, cookieHeader) {
  const response = await fetchHtml(input, cookieHeader);
  const resolved = resolveFacebookSource(response.url);
  if (resolved.ok) return { ...resolved, inputKind: 'share_url' };

  const targetId = extractCanonicalPostIdFromHtml(response.html);
  if (targetId) return { ok: true, sourceType: 'post', targetId, canonicalUrl: response.url, inputKind: 'share_url' };
  return resolved;
}

/**
 * Full resolution: offline parse first, then fetch HTML for pfbid / share URLs.
 * Uses the bot's stored cookies for authenticated HTML fetching.
 */
async function resolveFacebookInput(input) {
  let cookieHeader;
  try { cookieHeader = getCookieHeader(); } catch (_) { cookieHeader = ''; }

  const direct = resolveFacebookSource(input);
  if (direct.ok && direct.sourceType === 'post' && TEXT_POST_ID_PATTERN.test(direct.targetId) && direct.inputKind === 'canonical_url') {
    try { return await resolvePfbidPostUrl(input, direct, cookieHeader); } catch (_) { return direct; }
  }
  if (direct.ok || !isFacebookShareUrl(input)) return direct;
  try { return await resolveShareUrl(input, cookieHeader); } catch (_) { return direct; }
}

module.exports = {
  resolveFacebookSource,
  resolveFacebookInput,
  extractCanonicalPostIdFromHtml,
};
