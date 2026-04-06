require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Thiếu GEMINI_API_KEY');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🔥 SỬA TÊN MODEL Ở ĐÂY – dùng gemini-pro (ổn định nhất)
const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

function normalizeHistory(history) {
  if (!history || !Array.isArray(history)) return [];
  const valid = history.filter(msg => 
    (msg.role === 'user' || msg.role === 'model') && msg.content
  );
  const geminiHistory = valid.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));
  while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
    geminiHistory.shift();
  }
  return geminiHistory;
}

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'Thiếu tin nhắn' });

  try {
    const geminiHistory = normalizeHistory(history);
    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(message);
    const reply = result.response.text();
    res.json({ reply });
  } catch (error) {
    console.error('Gemini error:', error);
    let errorMessage = 'Lỗi xử lý từ Gemini';
    if (error.message?.includes('API key')) errorMessage = 'Sai API key';
    else if (error.message?.includes('quota')) errorMessage = 'Hết quota (60 req/phút)';
    else if (error.message?.includes('safety')) errorMessage = 'Nội dung bị chặn';
    else if (error.message?.includes('404') || error.message?.includes('not found')) 
      errorMessage = 'Model không khả dụng, hãy kiểm tra tên model hoặc dùng gemini-pro';
    res.status(500).json({ error: errorMessage, details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server Gemini chạy tại http://localhost:${PORT} với model gemini-pro`);
});
