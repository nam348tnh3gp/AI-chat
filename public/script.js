// State
let currentModel = 'gemini-2.0-flash';
let currentChatId = null;
let chats = new Map();
let isStreaming = false;
let modelsList = [];

// DOM elements
const modelSelect = document.getElementById('modelSelect');
const messagesContainer = document.getElementById('messagesContainer');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const themeToggle = document.getElementById('themeToggle');
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menuToggle');
const chatHistoryList = document.getElementById('chatHistoryList');
const exportChatBtn = document.getElementById('exportChatBtn');
const importChatBtn = document.getElementById('importChatBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const stopStreamBtn = document.getElementById('stopStreamBtn');
const modelStatus = document.getElementById('modelStatus');

// Load saved data
function loadFromStorage() {
  const savedChats = localStorage.getItem('gemini_chats');
  if (savedChats) chats = new Map(JSON.parse(savedChats));
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.setAttribute('data-theme', 'light');
  const lastModel = localStorage.getItem('last_model');
  if (lastModel) currentModel = lastModel;
}

function saveChats() {
  localStorage.setItem('gemini_chats', JSON.stringify(Array.from(chats.entries())));
}

// Fetch models
async function fetchModels() {
  const res = await fetch('/api/models');
  const data = await res.json();
  modelsList = data.models;
  modelSelect.innerHTML = '';
  for (const m of modelsList) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.id;
    if (m.id === currentModel) option.selected = true;
    modelSelect.appendChild(option);
  }
  if (modelsList.length === 0) modelStatus.innerText = '⚠️ No models found';
  else modelStatus.innerText = `✅ ${currentModel} ready`;
}

modelSelect.addEventListener('change', () => {
  currentModel = modelSelect.value;
  localStorage.setItem('last_model', currentModel);
  modelStatus.innerText = `✅ ${currentModel} ready`;
});

// Render messages with markdown & highlight
async function renderMessages(messages) {
  messagesContainer.innerHTML = '';
  if (!messages.length) {
    messagesContainer.innerHTML = `<div class="welcome-screen"><h1>✨ Gemini Advanced</h1><p>Chọn model và bắt đầu trò chuyện</p></div>`;
    return;
  }
  for (const msg of messages) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    const avatar = document.createElement('div');
    avatar.className = `message-avatar ${msg.role === 'user' ? 'user-avatar' : 'assistant-avatar'}`;
    avatar.innerHTML = msg.role === 'user' ? '<i class="material-icons">person</i>' : '<i class="material-icons">smart_toy</i>';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    const bubble = document.createElement('div');
    bubble.className = `bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`;
    if (msg.role === 'assistant') {
      const html = marked.parse(msg.content);
      bubble.innerHTML = html;
      bubble.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(block.textContent);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => copyBtn.textContent = 'Copy', 2000);
        };
        block.parentNode.insertBefore(copyBtn, block);
      });
    } else {
      bubble.textContent = msg.content;
    }
    const timeSpan = document.createElement('div');
    timeSpan.className = 'message-time';
    timeSpan.textContent = new Date(msg.timestamp).toLocaleTimeString();
    contentDiv.appendChild(bubble);
    contentDiv.appendChild(timeSpan);
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    messagesContainer.appendChild(messageDiv);
  }
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Send message with streaming
async function sendMessage() {
  const message = userInput.value.trim();
  if (!message || isStreaming) return;
  userInput.value = '';
  userInput.style.height = 'auto';

  let chat = chats.get(currentChatId);
  if (!chat) {
    const newId = Date.now().toString();
    currentChatId = newId;
    chat = { title: message.substring(0, 30), messages: [] };
    chats.set(currentChatId, chat);
    saveChats();
    renderHistoryList();
  }
  chat.messages.push({ role: 'user', content: message, timestamp: Date.now() });
  saveChats();
  renderMessages(chat.messages);

  const history = chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
  chat.messages.push({ role: 'assistant', content: '...', timestamp: Date.now() });
  renderMessages(chat.messages);

  isStreaming = true;
  stopStreamBtn.style.display = 'flex';
  sendBtn.disabled = true;

  let fullReply = '';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, modelName: currentModel, stream: true })
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullReply += parsed.text;
              chat.messages[chat.messages.length-1].content = fullReply;
              renderMessages(chat.messages);
            }
          } catch(e) {}
        }
      }
    }
    if (!fullReply) throw new Error('Empty reply');
    chat.messages[chat.messages.length-1].content = fullReply;
    if (chat.title === message.substring(0,30) && fullReply) chat.title = fullReply.substring(0,30) + '…';
    saveChats();
    renderMessages(chat.messages);
    renderHistoryList();
  } catch (err) {
    chat.messages.pop();
    chat.messages.push({ role: 'assistant', content: `❌ Error: ${err.message}`, timestamp: Date.now() });
    renderMessages(chat.messages);
    saveChats();
  } finally {
    isStreaming = false;
    stopStreamBtn.style.display = 'none';
    sendBtn.disabled = false;
  }
}

function stopStream() { isStreaming = false; } // simplified, actual abort requires AbortController

function renderHistoryList() {
  chatHistoryList.innerHTML = '';
  for (let [id, chat] of chats.entries()) {
    const item = document.createElement('div');
    item.className = `history-item ${id === currentChatId ? 'active' : ''}`;
    item.textContent = chat.title || 'New chat';
    item.onclick = () => {
      currentChatId = id;
      renderMessages(chats.get(id).messages);
      renderHistoryList();
    };
    chatHistoryList.appendChild(item);
  }
}

function newChat() {
  currentChatId = Date.now().toString();
  chats.set(currentChatId, { title: 'New chat', messages: [] });
  saveChats();
  renderMessages([]);
  renderHistoryList();
}

function clearCurrentChat() {
  if (currentChatId && chats.has(currentChatId)) {
    chats.get(currentChatId).messages = [];
    saveChats();
    renderMessages([]);
    renderHistoryList();
  }
}

function exportChat() {
  if (!currentChatId) return;
  const chat = chats.get(currentChatId);
  const dataStr = JSON.stringify({ id: currentChatId, title: chat.title, messages: chat.messages }, null, 2);
  const blob = new Blob([dataStr], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat_${currentChatId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importChat() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (ev) => {
      const chatData = JSON.parse(ev.target.result);
      chats.set(chatData.id, { title: chatData.title, messages: chatData.messages });
      saveChats();
      renderHistoryList();
      currentChatId = chatData.id;
      renderMessages(chatData.messages);
    };
    reader.readAsText(file);
  };
  input.click();
}

function clearAllHistory() {
  if (confirm('Delete all chats?')) {
    chats.clear();
    saveChats();
    currentChatId = null;
    renderMessages([]);
    renderHistoryList();
  }
}

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
});

userInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 150) + 'px';
});
userInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);
newChatBtn.addEventListener('click', newChat);
clearChatBtn.addEventListener('click', clearCurrentChat);
exportChatBtn.addEventListener('click', exportChat);
importChatBtn.addEventListener('click', importChat);
clearHistoryBtn.addEventListener('click', clearAllHistory);
stopStreamBtn.addEventListener('click', stopStream);
menuToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

loadFromStorage();
fetchModels().then(() => {
  if (chats.size === 0) newChat();
  else {
    currentChatId = Array.from(chats.keys())[0];
    renderMessages(chats.get(currentChatId).messages);
    renderHistoryList();
  }
});
