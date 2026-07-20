const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state');

module.exports = {
  ROOT,
  DATA_DIR,
  STATE_DIR,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  AUTHORIZED_USER_ID: process.env.AUTHORIZED_USER_ID || '',
  FB_API_VERSION: process.env.FB_API_VERSION || 'v25.0',
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || '200'),
  DEFAULT_DELAY_MS: Number(process.env.DEFAULT_DELAY_MS || '600'),
  SHEETS_WEBHOOK_URL: process.env.SHEETS_WEBHOOK_URL || '',
  SHEETS_SECRET_TOKEN: process.env.SHEETS_SECRET_TOKEN || '',
  SHEETS_FOLDER_ID: process.env.SHEETS_FOLDER_ID || process.env.GOOGLE_FOLDER_ID || '',
  EXPORT_CHUNK_SIZE: Number(process.env.EXPORT_CHUNK_SIZE || '1000'),
  EXPORT_DELAY_MS: Number(process.env.EXPORT_DELAY_MS || '600'),
  AUTO_TOKEN_REFRESH: process.env.AUTO_TOKEN_REFRESH !== 'false',
};
