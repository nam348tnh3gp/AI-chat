require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Kiểm tra thư mục public có tồn tại không
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  console.error(`❌ Thư mục "${publicDir}" không tồn tại! Tạo thư mục và thêm index.html.`);
  process.exit(1);
}

// Phục vụ file tĩnh với xử lý lỗi
app.use(express.static(publicDir, {
  fallthrough: false, // Không cho phép fallthrough, nếu thiếu file sẽ báo lỗi
  extensions: ['html', 'htm']
}));

// Xử lý riêng route gốc để đảm bảo index.html được phục vụ
app.get('/', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Không tìm thấy index.html trong thư mục public');
  }
});

// Kiểm tra biến môi trường
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Thiếu GEMINI_API_KEY trong biến môi trường');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Endpoint lấy danh sách model khả dụng
app.get('/api/models', async (req, res) => {
  try {
    const models = await genAI.listModels();
    const availableModels = models
      .filter(model => 
        model.supportedGenerationMethods?.includes('generateContent') &&
        model.name.startsWith('models/gemini')
      )
      .map(model => ({
        id: model.name.replace('models/', ''),
        displayName: model.displayName || model.name,
      }));
    availableModels.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models: availableModels });
  } catch (error) {
    console.error('Lỗi lấy danh sách model:', error);
    res.status(500).json({ error: 'Không thể lấy danh sách model', details: error.message });
  }
});

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
  const { message, history, modelName } = req.body;
  
  if (!message) return res.status(400).json({ error: 'Thiếu tin nhắn' });
  if (!modelName) return res.status(400).json({ error: 'Thiếu tên model' });

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
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
    else if (error.message?.includes('404') || error.message?.includes('not found')) 
      errorMessage = `Model "${modelName}" không khả dụng`;
    res.status(500).json({ error: errorMessage, details: error.message });
  }
});

// Middleware xử lý lỗi 404 cho các route khác
app.use((req, res) => {
  res.status(404).json({ error: 'Không tìm thấy đường dẫn' });
});

// Middleware xử lý lỗi chung
app.use((err, req, res, next) => {
  console.error('Lỗi server:', err);
  res.status(500).json({ error: 'Lỗi nội bộ server', details: err.message });
});

app.listen(PORT, () => {
  console.log(`✅ Server Gemini chạy tại http://localhost:${PORT}`);
  console.log(`📁 Thư mục public: ${publicDir}`);
});
