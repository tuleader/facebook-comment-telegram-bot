function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function profileUrl(id) { return id ? `https://www.facebook.com/${id}` : ''; }
function commentUrl(id) { return id ? `https://www.facebook.com/${id}` : ''; }
function compactTitle(s, max = 90) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
function topSheetName(topLimit) {
  const n = Number(topLimit);
  return Number.isInteger(n) && n > 0 ? `top_${n}_tuong_tac`.slice(0, 99) : null;
}

function buildInteractionRows(comments, ownerId) {
  const stats = new Map();
  for (const c of comments || []) {
    if (!c.authorId || (ownerId && c.authorId === ownerId)) continue;
    const st = stats.get(c.authorId) || { authorId: c.authorId, author: c.author || '', totalInteractions: 0 };
    if (c.author && !st.author) st.author = c.author;
    st.totalInteractions += 1;
    stats.set(c.authorId, st);
  }

  return [...stats.values()]
    .sort((a, b) => b.totalInteractions - a.totalInteractions || a.author.localeCompare(b.author, 'vi'))
    .map(s => ({
      'Tên FB': s.author,
      'Điểm TT': s.totalInteractions,
      'Link_Profile': profileUrl(s.authorId),
    }));
}

function buildWorkbook({ commentsResult, postInfo, sourceUrl, topLimit = null }) {
  const postId = commentsResult.sourcePostId;
  const ownerId = postInfo && postInfo.from && postInfo.from.id || '';
  const title = compactTitle(postInfo?.description || postInfo?.title || postInfo?.message || sourceUrl || postId);
  const commentHeaders = ['Thời gian', 'Tên FB', 'ID', 'Nội dung', 'ID_Comment', 'Link_Comment', 'Link_Profile'];
  const interactionHeaders = ['Tên FB', 'Điểm TT', 'Link_Profile'];

  const commentRows = (commentsResult.comments || []).map(c => ({
    'Thời gian': formatDate(c.createdTime),
    'Tên FB': c.author || '',
    'ID': c.authorId || '',
    'Nội dung': c.text || '',
    'ID_Comment': c.commentId || '',
    'Link_Comment': commentUrl(c.commentId),
    'Link_Profile': profileUrl(c.authorId),
  }));

  // Mặc định tab tương tác phải chứa TẤT CẢ user, đã xếp cao -> thấp.
  const interactionRows = buildInteractionRows(commentsResult.comments || [], ownerId);
  const sheets = [
    { sheetName: 'tat_ca_cmt', headers: commentHeaders, rows: commentRows },
    { sheetName: 'tat_ca_tuong_tac', headers: interactionHeaders, rows: interactionRows },
  ];

  const n = Number(topLimit);
  if (Number.isInteger(n) && n > 0) {
    sheets.push({ sheetName: topSheetName(n), headers: interactionHeaders, rows: interactionRows.slice(0, n) });
  }

  return {
    title,
    postId,
    ownerId,
    topLimit: Number.isInteger(n) && n > 0 ? n : null,
    sheets,
  };
}

module.exports = { buildWorkbook };
