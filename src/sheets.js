const { SHEETS_WEBHOOK_URL, SHEETS_SECRET_TOKEN, SHEETS_FOLDER_ID, EXPORT_CHUNK_SIZE, EXPORT_DELAY_MS } = require('./config');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function post(body) {
  if (!SHEETS_WEBHOOK_URL || !SHEETS_SECRET_TOKEN) {
    throw new Error('Thiếu SHEETS_WEBHOOK_URL hoặc SHEETS_SECRET_TOKEN trong .env');
  }
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SHEETS_SECRET_TOKEN, ...body }),
  });
  const text = await res.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { ok: false, raw: text }; }
  if (!res.ok || !result.ok) {
    const err = new Error(result.error || result.raw || `HTTP ${res.status}`);
    err.result = { httpStatus: res.status, ...result };
    throw err;
  }
  return { httpStatus: res.status, ...result };
}

async function appendWithRetry(body, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await post(body); }
    catch (error) { last = error; await sleep(2500 * (i + 1)); }
  }
  throw last;
}

async function exportWorkbook(workbook, { onProgress } = {}) {
  const createPayload = { action: 'create', title: workbook.title || `Facebook Export ${new Date().toISOString()}` };
  if (SHEETS_FOLDER_ID) createPayload.folderId = SHEETS_FOLDER_ID;
  const created = await post(createPayload);
  const spreadsheetId = created.spreadsheetId;
  const url = created.url;
  if (onProgress) await onProgress({ action: 'create', spreadsheetId, url, title: workbook.title });

  for (const sheet of workbook.sheets || []) {
    const sheetName = String(sheet.sheetName || 'Data').slice(0, 99);
    const headers = sheet.headers || [];
    const rows = sheet.rows || [];
    for (let start = 0; start < rows.length; start += EXPORT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + EXPORT_CHUNK_SIZE);
      const res = await appendWithRetry({ action: 'append', spreadsheetId, sheetName, headers, rows: chunk });
      if (onProgress) await onProgress({ action: 'append', sheetName, start: start + 1, rows: chunk.length, totalRows: res.totalRows });
      await sleep(EXPORT_DELAY_MS);
    }
    if (rows.length === 0) {
      await appendWithRetry({ action: 'append', spreadsheetId, sheetName, headers, rows: [] });
    }
    const fmt = await appendWithRetry({ action: 'format', spreadsheetId, sheetName });
    if (onProgress) await onProgress({ action: 'format', sheetName, totalRows: fmt.totalRows });
  }

  return { ok: true, spreadsheetId, url, title: workbook.title };
}

module.exports = { exportWorkbook };
