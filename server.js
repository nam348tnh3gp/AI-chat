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

// Endpoint lấy danh sách model khả dụng
app.get('/api/models', async (req, res) => {
  try {
    // Lấy danh sách model từ Gemini API
    const models = await genAI.listModels();
    // Lọc ra các model hỗ trợ generateContent (chat)
    const availableModels = models
      .filter(model => 
        model.supportedGenerationMethods?.includes('generateContent') &&
        model.name.startsWith('models/gemini')
      )
      .map(model => ({
        id: model.name.replace('models/', ''), // bỏ prefix 'models/'
        displayName: model.displayName || model.name,
        description: model.description
      }));
    
    // Sắp xếp: ưu tiên flash, pro, theo version
    availableModels.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models: availableModels });
  } catch (error) {
    console.error('Lỗi lấy danh sách model:', error);
    res.status(500).json({ error: 'Không thể lấy danh sách model', details: error.message });
  }
});

// Hàm chuẩn hóa lịch sử chat
function normalizeHistory(history) {
  if (!history || !Array.isArray(history)) return [];
  const valid = history.filter(msg => 
    (msg.role === 'user' || msg.role === 'model') && msg.content
  );
  const geminiHistory = valid.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));
  // Xóa các tin nhắn model ở đầu (nếu có)
  while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
    geminiHistory.shift();
  }
  return geminiHistory;
}

// Endpoint chat – nhận model name từ client
app.post('/api/chat', async (req, res) => {
  const { message, history, modelName } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Thiếu tin nhắn' });
  }
  if (!modelName) {
    return res.status(400).json({ error: 'Thiếu tên model' });
  }

  try {
    // Tạo model instance từ tên được chọn
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
    else if (error.message?.includes('safety')) errorMessage = 'Nội dung bị chặn do an toàn';
    else if (error.message?.includes('404') || error.message?.includes('not found')) 
      errorMessage = `Model "${modelName}" không khả dụng. Hãy chọn model khác.`;
    res.status(500).json({ error: errorMessage, details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server Gemini chạy tại http://localhost:${PORT}`);
});
