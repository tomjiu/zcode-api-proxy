'use strict';
/**
 * src/duckmail.js — DuckMail 临时邮箱客户端
 *
 * API: https://api.duckmail.sbs
 * 文档: https://github.com/MoonWeSif/DuckMail
 *
 * 功能：
 * - 创建临时邮箱账号
 * - 登录获取 token
 * - 轮询等待验证码邮件
 * - 提取验证码
 *
 * 配置（环境变量）：
 *   DUCKMAIL_API_URL   — API 地址（默认 https://api.duckmail.sbs）
 *   DUCKMAIL_API_KEY   — API Key（dk_xxx，可选，用于私有域名）
 */

const API_URL = (process.env.DUCKMAIL_API_URL || 'https://api.duckmail.sbs').replace(/\/+$/, '');
const API_KEY = process.env.DUCKMAIL_API_KEY || '';

const log = (...a) => process.stderr.write('[duckmail] ' + a.join(' ') + '\n');

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

async function request(method, path, body, token) {
  const url = `${API_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };

  // 认证：优先用 token，其次用 API Key
  const auth = token || API_KEY;
  if (auth) headers['Authorization'] = `Bearer ${auth}`;

  const init = { method, headers };
  if (body && method !== 'GET') init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  if (res.status === 204) return null;

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.message || data?.error || text.slice(0, 300);
    throw new Error(`DuckMail ${method} ${path} (${res.status}): ${msg}`);
  }

  return data;
}

// ─── Account API ──────────────────────────────────────────────────────────────

/**
 * 创建临时邮箱账号
 * @param {object} [opts]
 * @param {string} [opts.domain] - 域名（默认用系统域名）
 * @param {number} [opts.expiresIn] - 过期时间（秒），默认 24h
 * @returns {Promise<{id: string, address: string}>}
 */
async function createAccount(opts = {}) {
  const crypto = require('crypto');
  const username = crypto.randomBytes(5).toString('hex');
  const password = 'Dm' + crypto.randomBytes(4).toString('hex') + '!';

  const domain = opts.domain || 'duckmail.sbs';
  const address = `${username}@${domain}`;

  const body = { address, password };
  if (opts.expiresIn !== undefined) body.expiresIn = opts.expiresIn;

  const data = await request('POST', '/accounts', body);
  log('account created: ' + (data.address || address));

  // 登录获取 token
  const tokenData = await request('POST', '/token', { address: data.address || address, password });

  return {
    id: data.id || tokenData.id,
    address: data.address || address,
    password,
    token: tokenData.token,
  };
}

/**
 * 登录获取 token
 * @param {string} address - 邮箱地址
 * @param {string} password - 密码
 * @returns {Promise<{id: string, token: string}>}
 */
async function getToken(address, password) {
  return request('POST', '/token', { address, password });
}

// ─── Message API ──────────────────────────────────────────────────────────────

/**
 * 获取收件箱列表
 * @param {string} token - 认证 token
 * @param {number} [page=1]
 * @returns {Promise<{messages: Array, total: number}>}
 */
async function getMessages(token, page = 1) {
  const data = await request('GET', `/messages?page=${page}`, null, token);
  return {
    messages: data['hydra:member'] || [],
    total: data['hydra:totalItems'] || 0,
  };
}

/**
 * 获取邮件详情（含正文）
 * @param {string} token
 * @param {string} messageId
 * @returns {Promise<{id: string, subject: string, text: string, html: string[], from: object}>}
 */
async function getMessageDetail(token, messageId) {
  return request('GET', `/messages/${messageId}`, null, token);
}

// ─── High-Level API ───────────────────────────────────────────────────────────

/**
 * 创建邮箱并等待验证码
 * @param {object} opts
 * @param {string} [opts.domain] - 域名
 * @param {number} [opts.timeoutMs=120000] - 超时
 * @param {number} [opts.pollIntervalMs=3000] - 轮询间隔
 * @param {RegExp} [opts.codePattern] - 验证码正则（默认 6 位数字）
 * @param {Set} [opts.seenIds] - 已见邮件 ID（排除旧邮件）
 * @returns {Promise<{address: string, token: string, code: string, subject: string, body: string}>}
 */
async function createAndWait(opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const pollIntervalMs = opts.pollIntervalMs || 3000;
  const codePattern = opts.codePattern || /\b(\d{6})\b/;

  // 创建账号
  const account = await createAccount({ domain: opts.domain });
  log('waiting for code on: ' + account.address);

  const seenIds = new Set(opts.seenIds || []);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    try {
      const { messages } = await getMessages(account.token);

      for (const msg of messages) {
        const mid = String(msg.id || msg.msgid || '');
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);

        // 获取邮件详情
        const detail = await getMessageDetail(account.token, mid);
        const body = detail.text || (detail.html || []).join(' ') || '';

        // 提取验证码
        const match = body.match(codePattern);
        if (match) {
          const code = match[1] || match[0];
          log('code found: ' + code + ' from: ' + (detail.from?.address || 'unknown'));
          return {
            address: account.address,
            token: account.token,
            password: account.password,
            code,
            subject: detail.subject || '',
            body: body.slice(0, 500),
            messageId: mid,
          };
        }
      }
    } catch (e) {
      log('poll error: ' + e.message);
    }
  }

  throw new Error('Timeout waiting for verification code (' + timeoutMs + 'ms)');
}

/**
 * 用已有 token 等待验证码（不创建新账号）
 * @param {string} token
 * @param {object} [opts]
 * @returns {Promise<{code: string, subject: string}>}
 */
async function waitCode(token, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const pollIntervalMs = opts.pollIntervalMs || 3000;
  const codePattern = opts.codePattern || /\b(\d{6})\b/;
  const seenIds = new Set(opts.seenIds || []);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    try {
      const { messages } = await getMessages(token);
      for (const msg of messages) {
        const mid = String(msg.id || msg.msgid || '');
        if (seenIds.has(mid)) continue;
        seenIds.add(mid);

        const detail = await getMessageDetail(token, mid);
        const body = detail.text || (detail.html || []).join(' ') || '';
        const match = body.match(codePattern);
        if (match) {
          return { code: match[1] || match[0], subject: detail.subject || '', body: body.slice(0, 500) };
        }
      }
    } catch {}
  }

  throw new Error('Timeout waiting for code (' + timeoutMs + 'ms)');
}

module.exports = {
  createAccount,
  getToken,
  getMessages,
  getMessageDetail,
  createAndWait,
  waitCode,
};
