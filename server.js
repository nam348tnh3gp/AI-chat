// Đọc biến môi trường từ file .env (chỉ dùng trong phát triển)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Phục vụ file tĩnh (frontend)
app.use(express.static('public'));

// Khởi tạo OpenAI client với API key từ biến môi trường
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Endpoint chat
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Thiếu tin nhắn' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // hoặc 'gpt-4' nếu có quyền truy cập
      messages: [
        { role: 'system', content: 'Bạn là trợ lý AI hữu ích.' },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('OpenAI error:', error);
    res.status(500).json({ error: 'Lỗi xử lý từ AI' });
  }
});

// Khởi động server
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
