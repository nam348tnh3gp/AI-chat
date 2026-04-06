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
  console.error('❌ Thiếu GEMINI_API_KEY trong biến môi trường');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Hàm chuẩn hóa lịch sử từ frontend
function normalizeHistory(history) {
  if (!history || !Array.isArray(history)) return [];
  
  // Chỉ giữ lại các tin nhắn có role 'user' hoặc 'model' và có nội dung
  const valid = history.filter(msg => 
    (msg.role === 'user' || msg.role === 'model') && msg.content
  );
  
  // Chuyển sang format Gemini
  const geminiHistory = valid.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));
  
  // 🔥 Quan trọng: Xóa các tin nhắn 'model' ở đầu mảng (nếu có)
  while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
    geminiHistory.shift();
  }
  
  return geminiHistory;
}

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Thiếu tin nhắn' });
  }

  try {
    const geminiHistory = normalizeHistory(history);
    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    res.json({ reply });
  } catch (error) {
    console.error('Gemini error:', error);
    let errorMessage = 'Lỗi xử lý từ Gemini';
    if (error.message?.includes('API key')) errorMessage = 'Sai API key Gemini';
    else if (error.message?.includes('quota')) errorMessage = 'Hết quota (60 request/phút)';
    else if (error.message?.includes('safety')) errorMessage = 'Nội dung bị chặn do an toàn';
    else if (error.message?.includes('role')) errorMessage = 'Lỗi cấu trúc lịch sử chat';
    res.status(500).json({ error: errorMessage, details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server Gemini chạy tại http://localhost:${PORT}`);
});
