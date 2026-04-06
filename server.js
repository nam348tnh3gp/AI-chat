require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Kiểm tra biến môi trường
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ THIẾU GEMINI_API_KEY trong biến môi trường!');
  process.exit(1);
}

// Khởi tạo Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Dùng model ổn định, hỗ trợ multi-turn
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Lưu lịch sử chat theo session (nếu cần, ở đây dùng tạm Map, production nên dùng Redis)
const chatSessions = new Map();

// Endpoint chat (hỗ trợ lịch sử)
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Thiếu tin nhắn' });
  }

  try {
    let chat;
    let effectiveSessionId = sessionId || 'default';

    // Nếu có lịch sử gửi lên (từ frontend) thì dùng
    if (history && Array.isArray(history)) {
      // Chuyển đổi lịch sử từ frontend (role: user/model) sang format Gemini
      const geminiHistory = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));
      chat = model.startChat({ history: geminiHistory });
    } 
    // Nếu không có lịch sử nhưng có sessionId, dùng session lưu trên server
    else if (chatSessions.has(effectiveSessionId)) {
      chat = chatSessions.get(effectiveSessionId);
    } 
    else {
      chat = model.startChat();
      chatSessions.set(effectiveSessionId, chat);
    }

    // Gửi tin nhắn và nhận phản hồi
    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    // Lưu lại chat session (nếu chưa lưu)
    if (!chatSessions.has(effectiveSessionId)) {
      chatSessions.set(effectiveSessionId, chat);
    }

    res.json({ reply, sessionId: effectiveSessionId });
  } catch (error) {
    console.error('Gemini error:', error);
    let errorMessage = 'Lỗi xử lý từ Gemini';
    if (error.message?.includes('API key')) errorMessage = 'Sai hoặc thiếu API key Gemini';
    else if (error.message?.includes('quota')) errorMessage = 'Hết quota Gemini (vẫn còn miễn phí 60 req/phút)';
    else if (error.message?.includes('safety')) errorMessage = 'Nội dung bị chặn do an toàn';
    res.status(500).json({ error: errorMessage, details: error.message });
  }
});

// Endpoint streaming (tuỳ chọn, nâng cao)
app.post('/api/chat/stream', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'Thiếu tin nhắn' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    let chat;
    if (history && Array.isArray(history)) {
      const geminiHistory = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));
      chat = model.startChat({ history: geminiHistory });
    } else {
      chat = model.startChat();
    }

    const result = await chat.sendMessageStream(message);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server Gemini chạy tại http://localhost:${PORT}`);
});
