require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// ===== Check Node version =====
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 18) {
  console.error(`❌ Cần Node.js >= 18 (hiện tại: ${process.versions.node})`);
  console.error('   Vì server dùng fetch() built-in.');
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY');
  console.error('   Tạo file .env với nội dung: GEMINI_API_KEY=AIzaSy...');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ===== Fallback chain (thứ tự ưu tiên khi model chính lỗi 503) =====
const FALLBACK_CHAIN = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-001',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  HELPERS
// ============================================================

/** Xây contents hợp lệ cho Gemini: bắt đầu user, kết thúc model, không trùng role */
function buildContents(message, history) {
  const contents = [];

  if (Array.isArray(history)) {
    const clean = history
      .filter(h => h && (h.role === 'user' || h.role === 'model')
        && typeof h.content === 'string' && h.content.trim())
      .map(h => ({ role: h.role, parts: [{ text: h.content }] }));

    // Bỏ đầu nếu không phải user
    while (clean.length && clean[0].role !== 'user') clean.shift();

    // Merge liên tiếp cùng role
    const merged = [];
    for (const h of clean) {
      const last = merged[merged.length - 1];
      if (last && last.role === h.role) {
        last.parts[0].text += '\n\n' + h.parts[0].text;
      } else {
        merged.push({ role: h.role, parts: [{ text: h.parts[0].text }] });
      }
    }

    // Bỏ cuối nếu không phải model
    while (merged.length && merged[merged.length - 1].role !== 'model') merged.pop();

    contents.push(...merged);
  }

  contents.push({ role: 'user', parts: [{ text: message }] });
  return contents;
}

/** Chuyển lỗi thô thành message thân thiện + HTTP code */
function friendlyError(rawMsg, modelName) {
  const m = String(rawMsg || '');
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(m)) {
    return { code: 401, msg: 'API key không hợp lệ. Kiểm tra GEMINI_API_KEY trong .env' };
  }
  if (/PERMISSION_DENIED|403/i.test(m)) {
    return { code: 403, msg: 'API key không có quyền truy cập model này.' };
  }
  if (/404|not found|is not supported/i.test(m)) {
    return { code: 404, msg: `Model "${modelName}" không tồn tại hoặc không hỗ trợ generateContent.` };
  }
  if (/429|quota|RESOURCE_EXHAUSTED|rate limit/i.test(m)) {
    return { code: 429, msg: 'Đã vượt hạn mức (rate limit). Đợi 30–60 giây rồi thử lại.' };
  }
  if (/503|high demand|overloaded|UNAVAILABLE/i.test(m)) {
    return { code: 503, msg: 'Model đang quá tải. Đợi 10–30 giây hoặc đổi model khác.' };
  }
  if (/SAFETY|blocked/i.test(m)) {
    return { code: 400, msg: 'Nội dung bị chặn bởi safety filter của Gemini.' };
  }
  if (/RECITATION/i.test(m)) {
    return { code: 400, msg: 'Phản hồi bị chặn do trùng lặp nội dung có bản quyền.' };
  }
  if (/MAX_TOKENS/i.test(m)) {
    return { code: 400, msg: 'Đã đạt giới hạn token tối đa.' };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|timeout/i.test(m)) {
    return { code: 503, msg: 'Không kết nối được tới Gemini API. Kiểm tra mạng.' };
  }
  return { code: 500, msg: m || 'Lỗi server' };
}

/** Retry với exponential backoff cho lỗi tạm thời (503, 429, 500) */
async function withRetry(fn, { retries = 3, baseDelay = 1000, label = 'call' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const isRetryable = /(\b503\b|\b429\b|\b500\b|\b502\b|\b504\b|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|rate limit)/i.test(msg);

      if (!isRetryable || attempt === retries) {
        if (isRetryable && attempt === retries) {
          console.error(`[retry] ${label}: hết ${retries} lần thử`);
        }
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300;
      console.warn(`[retry] ${label}: lỗi tạm thời (lần ${attempt + 1}/${retries}), thử lại sau ${Math.round(delay)}ms`);
      console.warn(`[retry]   → ${msg.slice(0, 120)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ============================================================
//  MODELS
// ============================================================
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_TTL = 5 * 60 * 1000;

async function getModels(force = false) {
  const now = Date.now();
  if (!force && modelsCache && now - modelsCacheTime < MODELS_TTL) return modelsCache;

  const url = `${BASE_URL}/models?key=${API_KEY}&pageSize=100`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Fetch models failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  modelsCache = (data.models || [])
    .filter(m =>
      m.supportedGenerationMethods?.includes('generateContent') &&
      m.name.startsWith('models/gemini')
    )
    .map(m => ({
      id: m.name.replace('models/', ''),
      displayName: m.displayName || m.name.replace('models/', ''),
      description: m.description || '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelsCacheTime = now;
  return modelsCache;
}

app.get('/api/models', async (req, res) => {
  try {
    const models = await getModels(req.query.refresh === '1');
    res.json({ models });
  } catch (err) {
    console.error('[models]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, node: process.versions.node, api: BASE_URL });
});

// ============================================================
//  GỌI GEMINI — REST API trực tiếp (giống Python)
// ============================================================
async function callGemini(modelName, contents, { timeout = 45000 } = {}) {
  const url = `${BASE_URL}/models/${modelName}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
    signal: AbortSignal.timeout(timeout),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errMsg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  const cand = data?.candidates?.[0];
  if (!cand) {
    throw new Error('Gemini trả về response rỗng (không có candidates)');
  }

  const text = cand.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) {
    const fr = cand.finishReason || 'UNKNOWN';
    throw new Error(`Gemini không trả về nội dung (finishReason: ${fr})`);
  }
  return text;
}

/** Gọi Gemini với retry + fallback model khi model chính lỗi 503 */
async function callGeminiWithFallback(modelName, contents) {
  const tryList = [modelName];
  for (const m of FALLBACK_CHAIN) {
    if (!tryList.includes(m)) tryList.push(m);
  }

  let lastErr;
  for (let i = 0; i < tryList.length; i++) {
    const m = tryList[i];
    try {
      if (i > 0) console.log(`[fallback] thử model: ${m}`);
      const reply = await withRetry(
        () => callGemini(m, contents),
        { retries: 2, baseDelay: 1200, label: m }
      );
      if (i > 0) console.log(`[fallback] ✔ ${m} thành công`);
      return { reply, modelUsed: m };
    } catch (err) {
      lastErr = err;
      const isTemp = /503|429|500|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(err.message || '');
      if (!isTemp || i === tryList.length - 1) {
        throw err;
      }
      console.warn(`[fallback] ${m} thất bại → chuyển model kế tiếp`);
    }
  }
  throw lastErr;
}

// ============================================================
//  /api/chat — Non-stream, trả JSON (giống Python)
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { message, history, modelName } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message không hợp lệ' });
  }
  if (message.length > 50000) {
    return res.status(400).json({ error: 'Message quá dài (tối đa 50k ký tự)' });
  }
  if (!modelName || typeof modelName !== 'string') {
    return res.status(400).json({ error: 'Thiếu model' });
  }

  const contents = buildContents(message, history);
  console.log(`\n[chat] ▶ model=${modelName} history=${contents.length - 1} msg="${message.slice(0, 60)}${message.length > 60 ? '…' : ''}"`);

  try {
    const { reply, modelUsed } = await callGeminiWithFallback(modelName, contents);
    console.log(`[chat] ✔ OK model=${modelUsed} len=${reply.length}`);
    res.json({ reply, modelUsed });
  } catch (err) {
    console.error('[chat] ❌', err.message);
    const { code, msg } = friendlyError(err.message, modelName);
    res.status(code).json({ error: msg, raw: err.message });
  }
});

// ============================================================
//  /api/chat/stream — SSE, server tự chunk để có typing effect
// ============================================================
app.post('/api/chat/stream', async (req, res) => {
  const { message, history, modelName } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message không hợp lệ' });
  }
  if (message.length > 50000) {
    return res.status(400).json({ error: 'Message quá dài (tối đa 50k ký tự)' });
  }
  if (!modelName || typeof modelName !== 'string') {
    return res.status(400).json({ error: 'Thiếu model' });
  }

  const contents = buildContents(message, history);
  console.log(`\n[chat/stream] ▶ model=${modelName} history=${contents.length - 1}`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { reply, modelUsed } = await callGeminiWithFallback(modelName, contents);

    if (aborted) {
      console.log('[chat/stream] client aborted before send');
      return;
    }

    // Gửi meta model được dùng (nếu fallback)
    if (modelUsed !== modelName) {
      send({ modelUsed });
    }

    // Chunk theo từ (giữ khoảng trắng) để có hiệu ứng typing
    const tokens = reply.match(/\S+\s*|\s+/g) || [reply];
    const CHUNK_MS = 12; // delay giữa các chunk

    for (const token of tokens) {
      if (aborted) break;
      send({ text: token });
      // Delay nhỏ để có hiệu ứng (nhưng không quá chậm)
      if (token.length > 2 || /[.!?,;:\n]/.test(token)) {
        await new Promise(r => setTimeout(r, CHUNK_MS));
      }
    }

    if (!aborted) {
      send({ done: true });
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[chat/stream] ✔ done model=${modelUsed} len=${reply.length}`);
    }
  } catch (err) {
    console.error('[chat/stream] ❌', err.message);
    if (!res.headersSent) {
      const { code, msg } = friendlyError(err.message, modelName);
      return res.status(code).json({ error: msg });
    }
    const { msg } = friendlyError(err.message, modelName);
    send({ error: msg, raw: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Server chạy tại http://localhost:${PORT}`);
  console.log(`   Node: ${process.versions.node}`);
  console.log(`   API:  ${BASE_URL}`);
  console.log(`   Key:  ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
});