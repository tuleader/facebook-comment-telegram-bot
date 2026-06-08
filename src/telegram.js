const fs = require('fs');
const path = require('path');
const { DATA_DIR, TELEGRAM_BOT_TOKEN } = require('./config');

function apiUrl(method) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Thiếu TELEGRAM_BOT_TOKEN trong .env');
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function tg(method, payload = {}) {
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  const chunks = splitText(text, 3900);
  let last;
  for (const chunk of chunks) {
    last = await tg('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true, ...extra });
  }
  return last;
}

async function editMessage(chatId, messageId, text) {
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }).catch(() => null);
}

function splitText(text, max) {
  const s = String(text || '');
  if (s.length <= max) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

async function getUpdates(offset, timeout = 30) {
  return tg('getUpdates', { offset, timeout, allowed_updates: ['message'] });
}

async function downloadFile(fileId, suggestedName = 'telegram-file') {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = await tg('getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được file Telegram: HTTP ${res.status}`);
  const ext = path.extname(file.file_path || suggestedName) || path.extname(suggestedName) || '.bin';
  const out = path.join(DATA_DIR, `upload_${Date.now()}${ext}`);
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(out, Buffer.from(arrayBuffer), { mode: 0o600 });
  return out;
}

module.exports = { tg, sendMessage, editMessage, getUpdates, downloadFile };
