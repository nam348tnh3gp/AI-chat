require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Lấy danh sách model qua REST API
async function getAvailableModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.models) return [];
  return data.models
    .filter(m => m.supportedGenerationMethods?.includes('generateContent') && m.name.startsWith('models/gemini'))
    .map(m => ({ id: m.name.replace('models/', ''), displayName: m.displayName || m.name }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

app.get('/api/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json({ models });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// Endpoint chat với streaming
app.post('/api/chat', async (req, res) => {
  const { message, history, modelName, stream = false } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  if (!modelName) return res.status(400).json({ error: 'No model' });

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    let chatHistory = [];
    if (history && Array.isArray(history)) {
      chatHistory = history
        .filter(h => h.role === 'user' || h.role === 'model')
        .map(h => ({ role: h.role, parts: [{ text: h.content }] }));
      while (chatHistory.length > 0 && chatHistory[0].role !== 'user') chatHistory.shift();
    }
    const chat = model.startChat({ history: chatHistory });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const result = await chat.sendMessageStream(message);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const result = await chat.sendMessage(message);
      res.json({ reply: result.response.text() });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
