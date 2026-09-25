require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ---- Models cache (tránh gọi API mỗi request) ----
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000;

async function getAvailableModels(force = false) {
  const now = Date.now();
  if (!force && modelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return modelsCache;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch models (${res.status})`);
  const data = await res.json();
  if (!data.models) return [];

  modelsCache = data.models
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
    const models = await getAvailableModels(req.query.refresh === '1');
    res.json({ models });
  } catch (err) {
    console.error('[models]', err);
    res.status(500).json({ error: err.message || 'Failed to fetch models' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Chat endpoint ----
app.post('/api/chat', async (req, res) => {
  const { message, history, modelName, stream = false } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message không hợp lệ' });
  }
  if (message.length > 50000) {
    return res.status(400).json({ error: 'Message quá dài (tối đa 50k ký tự)' });
  }
  if (!modelName || typeof modelName !== 'string') {
    return res.status(400).json({ error: 'Thiếu model' });
  }

  // Xây history hợp lệ cho Gemini (phải bắt đầu bằng user, kết thúc bằng model, không trùng role liên tiếp)
  let chatHistory = [];
  if (Array.isArray(history)) {
    chatHistory = history
      .filter(h => h && (h.role === 'user' || h.role === 'model')
        && typeof h.content === 'string' && h.content.trim())
      .map(h => ({ role: h.role, parts: [{ text: h.content }] }));

    while (chatHistory.length && chatHistory[0].role !== 'user') chatHistory.shift();

    const merged = [];
    for (const h of chatHistory) {
      const last = merged[merged.length - 1];
      if (last && last.role === h.role) {
        last.parts[0].text += '\n\n' + h.parts[0].text;
      } else {
        merged.push({ role: h.role, parts: [{ text: h.parts[0].text }] });
      }
    }
    chatHistory = merged;
    while (chatHistory.length && chatHistory[chatHistory.length - 1].role !== 'model') {
      chatHistory.pop();
    }
  }

  // Client ngắt kết nối → dừng stream
  let aborted = false;
  const onClose = () => { aborted = true; };
  req.on('close', onClose);

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const chat = model.startChat({ history: chatHistory });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.flushHeaders) res.flushHeaders();

      const result = await chat.sendMessageStream(message);
      for await (const chunk of result.stream) {
        if (aborted) break;
        let text = '';
        try { text = chunk.text(); } catch { /* ignore empty chunk */ }
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
      if (!aborted) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const result = await chat.sendMessage(message);
      res.json({ reply: result.response.text() });
    }
  } catch (err) {
    console.error('[chat]', err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Lỗi server' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(500).json({ error: err.message || 'Lỗi server' });
    }
  } finally {
    req.off('close', onClose);
  }
});

app.listen(PORT, () => console.log(`✅ Server chạy tại http://localhost:${PORT}`));