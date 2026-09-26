/* ============================================================
 *  Gemini Chat – Frontend (v3.1)
 * ============================================================ */

/* ===== Guard: CDN fallback ===== */
if (typeof marked === 'undefined') {
  console.warn('marked.js chưa load — dùng escape cơ bản');
  window.marked = {
    setOptions: () => {},
    parse: (t) => String(t).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])),
  };
}
if (typeof DOMPurify === 'undefined') {
  console.warn('DOMPurify chưa load — không sanitize (không an toàn)');
  window.DOMPurify = { sanitize: (h) => h };
}
if (typeof hljs === 'undefined') {
  window.hljs = { highlightElement: () => {} };
}

/* ===== Constants ===== */
const STORAGE_CHATS = 'gemini_chats_v3';
const STORAGE_THEME = 'theme';
const STORAGE_MODEL = 'last_model';
const DEFAULT_MODEL = 'gemini-2.0-flash';

const SUGGESTIONS = [
  { label: 'Giải thích', text: 'Giải thích khái niệm machine learning cho người mới bắt đầu' },
  { label: 'Viết code',  text: 'Viết hàm JavaScript kiểm tra số nguyên tố tối ưu' },
  { label: 'Dịch thuật', text: 'Dịch đoạn văn sau sang tiếng Anh: "Hôm nay trời đẹp, chúng tôi đi dạo"' },
  { label: 'Sáng tạo',   text: 'Viết một bài thơ ngắn về mùa thu Hà Nội' },
];

/* ===== DOM ===== */
const $ = id => document.getElementById(id);
const els = {
  modelSelect:       $('modelSelect'),
  messagesContainer: $('messagesContainer'),
  userInput:         $('userInput'),
  sendBtn:           $('sendBtn'),
  newChatBtn:        $('newChatBtn'),
  clearChatBtn:      $('clearChatBtn'),
  themeToggle:       $('themeToggle'),
  sidebar:           $('sidebar'),
  sidebarBackdrop:   $('sidebarBackdrop'),
  menuToggle:        $('menuToggle'),
  closeSidebarBtn:   $('closeSidebarBtn'),
  chatHistoryList:   $('chatHistoryList'),
  exportChatBtn:     $('exportChatBtn'),
  importChatBtn:     $('importChatBtn'),
  clearHistoryBtn:   $('clearHistoryBtn'),
  stopStreamBtn:     $('stopStreamBtn'),
  modelStatus:       $('modelStatus'),
  scrollBottomBtn:   $('scrollBottomBtn'),
  searchChats:       $('searchChats'),
  toastContainer:    $('toastContainer'),
};

/* ===== State ===== */
let currentModel = DEFAULT_MODEL;
let currentChatId = null;
let chats = new Map();
let isStreaming = false;
let modelsList = [];
let abortController = null;
let autoScroll = true;

/* ============================================================
 *  TOAST
 * ============================================================ */
function toast(message, type = 'info', timeout = 3000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  els.toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

/* ============================================================
 *  CLIPBOARD (có fallback cho HTTP / browser cũ)
 * ============================================================ */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ============================================================
 *  STORAGE
 * ============================================================ */
function loadFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_CHATS);
    if (saved) chats = new Map(JSON.parse(saved));
  } catch (e) {
    console.error('Load chats failed', e);
    chats = new Map();
  }
  const theme = localStorage.getItem(STORAGE_THEME)
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);

  const lastModel = localStorage.getItem(STORAGE_MODEL);
  if (lastModel) currentModel = lastModel;
}

function saveChats() {
  try {
    localStorage.setItem(STORAGE_CHATS, JSON.stringify(Array.from(chats.entries())));
  } catch (e) {
    console.error('Save chats failed', e);
    toast('Không lưu được (localStorage đầy?)', 'error');
  }
}

/* ============================================================
 *  THEME
 * ============================================================ */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_THEME, theme);
  const icon = els.themeToggle.querySelector('i');
  if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ============================================================
 *  MARKDOWN
 * ============================================================ */
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text) {
  if (!text) return '';
  const html = marked.parse(text);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });
}

/* ============================================================
 *  CODE BLOCKS — highlight + nút copy + nhãn ngôn ngữ
 * ============================================================ */
function detectLang(codeEl) {
  if (!codeEl) return '';
  const cls = codeEl.className || '';
  const m = cls.match(/language-([\w+#.-]+)/i);
  if (m) return m[1].toLowerCase();

  const cand = Array.from(codeEl.classList).find(
    c => c !== 'hljs' && !c.startsWith('language-') && /^[a-z0-9+#.-]{2,}$/i.test(c)
  );
  return cand ? cand.toLowerCase() : '';
}

function enhanceCodeBlocks(container, { addCopyButtons = true } = {}) {
  // Link mở tab mới an toàn
  container.querySelectorAll('a').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });

  // Highlight tất cả <pre><code>
  container.querySelectorAll('pre code').forEach(block => {
    try { hljs.highlightElement(block); } catch { /* ignore */ }
  });

  if (!addCopyButtons) return;

  container.querySelectorAll('pre').forEach(pre => {
    if (pre.closest('.code-block-wrap')) return;
    if (pre.querySelector('.copy-code-btn')) return;

    const codeEl = pre.querySelector('code');
    const lang = detectLang(codeEl);

    // Wrap <pre> để nhãn + nút không bị cuộn theo code
    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    // Nhãn ngôn ngữ
    if (lang) {
      const label = document.createElement('span');
      label.className = 'code-lang-label';
      label.textContent = lang;
      wrap.appendChild(label);
    }

    // Nút copy
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.title = 'Sao chép code';
    btn.setAttribute('aria-label', 'Sao chép code');
    btn.innerHTML = '<i class="material-icons">content_copy</i><span>Sao chép</span>';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = pre.querySelector('code') || pre;
      const ok = await copyToClipboard(target.textContent);

      if (ok) {
        btn.classList.add('copied');
        btn.innerHTML = '<i class="material-icons">check</i><span>Đã chép</span>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<i class="material-icons">content_copy</i><span>Sao chép</span>';
        }, 1600);
      } else {
        toast('Không sao chép được', 'error', 2000);
      }
    });

    wrap.appendChild(btn);
  });
}

/* ============================================================
 *  MESSAGE RENDERING
 * ============================================================ */
function createMessageElement(msg) {
  const wrap = document.createElement('div');
  wrap.className = `message ${msg.role}`;

  const avatar = document.createElement('div');
  avatar.className = `message-avatar ${msg.role === 'user' ? 'user-avatar' : 'assistant-avatar'}`;
  avatar.innerHTML = msg.role === 'user'
    ? '<i class="material-icons">person</i>'
    : '<i class="material-icons">smart_toy</i>';

  const body = document.createElement('div');
  body.className = 'message-body';

  const bubble = document.createElement('div');
  bubble.className = `bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`;

  if (msg.role === 'user') {
    bubble.textContent = msg.content;
  } else {
    if (msg.content) {
      bubble.innerHTML = renderMarkdown(msg.content);
      enhanceCodeBlocks(bubble);
    } else {
      bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    }
  }

  body.appendChild(bubble);

  // Meta
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const time = document.createElement('span');
  time.textContent = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : '';
  meta.appendChild(time);

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'mini-icon-btn';
  copyBtn.title = 'Sao chép tin nhắn';
  copyBtn.innerHTML = '<i class="material-icons">content_copy</i>';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(msg.content);
    toast(ok ? 'Đã sao chép' : 'Không sao chép được', ok ? 'success' : 'error', 1500);
  });
  actions.appendChild(copyBtn);

  if (msg.role === 'assistant' && msg.content) {
    const regenBtn = document.createElement('button');
    regenBtn.className = 'mini-icon-btn';
    regenBtn.title = 'Tạo lại';
    regenBtn.innerHTML = '<i class="material-icons">refresh</i>';
    regenBtn.addEventListener('click', regenerateLast);
    actions.appendChild(regenBtn);
  }

  meta.appendChild(actions);
  body.appendChild(meta);

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

function renderMessages(messages) {
  els.messagesContainer.innerHTML = '';
  if (!messages || messages.length === 0) {
    renderWelcomeScreen();
    return;
  }
  for (const m of messages) {
    els.messagesContainer.appendChild(createMessageElement(m));
  }
  scrollToBottom(true);
}

function renderWelcomeScreen() {
  const wrap = document.createElement('div');
  wrap.className = 'welcome-screen';
  wrap.innerHTML = `
    <h1>✨ Gemini Advanced</h1>
    <p>Chọn model và bắt đầu trò chuyện</p>
    <div class="suggestions"></div>
  `;
  const grid = wrap.querySelector('.suggestions');
  for (const s of SUGGESTIONS) {
    const btn = document.createElement('button');
    btn.className = 'suggestion';
    btn.innerHTML = `<span class="label">${s.label}</span>${s.text}`;
    btn.addEventListener('click', () => {
      els.userInput.value = s.text;
      els.userInput.focus();
      autoResize();
      sendMessage();
    });
    grid.appendChild(btn);
  }
  els.messagesContainer.appendChild(wrap);
}

/* ============================================================
 *  SCROLL
 * ============================================================ */
function scrollToBottom(force = false) {
  if (!force && !autoScroll) return;
  els.messagesContainer.scrollTop = els.messagesContainer.scrollHeight;
}

function updateScrollBtn() {
  const c = els.messagesContainer;
  const distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
  autoScroll = distFromBottom < 80;
  els.scrollBottomBtn.classList.toggle('visible', distFromBottom > 200);
}

els.messagesContainer.addEventListener('scroll', updateScrollBtn, { passive: true });
els.scrollBottomBtn.addEventListener('click', () => {
  autoScroll = true;
  scrollToBottom(true);
  updateScrollBtn();
});

/* ============================================================
 *  MODELS
 * ============================================================ */
async function fetchModels() {
  els.modelStatus.textContent = 'Đang tải models…';
  els.modelStatus.className = 'model-status';
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    modelsList = data.models || [];

    els.modelSelect.innerHTML = '';
    if (!modelsList.length) {
      els.modelSelect.innerHTML = '<option>Không có model</option>';
      els.modelStatus.textContent = 'Không có model khả dụng';
      els.modelStatus.className = 'model-status err';
      return;
    }

    if (!modelsList.some(m => m.id === currentModel)) {
      currentModel = modelsList[0].id;
      localStorage.setItem(STORAGE_MODEL, currentModel);
    }

    for (const m of modelsList) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === currentModel) opt.selected = true;
      els.modelSelect.appendChild(opt);
    }
    updateModelStatus();
  } catch (err) {
    console.error(err);
    els.modelStatus.textContent = 'Không tải được models';
    els.modelStatus.className = 'model-status err';
    toast('Không tải được danh sách model', 'error');
  }
}

function updateModelStatus() {
  if (!currentModel) return;
  els.modelStatus.textContent = `${currentModel} sẵn sàng`;
  els.modelStatus.className = 'model-status ok';
}

els.modelSelect.addEventListener('change', () => {
  currentModel = els.modelSelect.value;
  localStorage.setItem(STORAGE_MODEL, currentModel);
  updateModelStatus();
});

/* ============================================================
 *  SEND MESSAGE
 * ============================================================ */
async function sendMessage() {
  const message = els.userInput.value.trim();
  if (!message || isStreaming) return;

  els.userInput.value = '';
  autoResize();

  // Ensure chat exists
  let chat = currentChatId ? chats.get(currentChatId) : null;
  if (!chat) {
    const id = Date.now().toString();
    currentChatId = id;
    chat = { title: message.slice(0, 40), messages: [], createdAt: Date.now() };
    chats.set(id, chat);
    renderHistoryList();
    els.messagesContainer.innerHTML = '';
  }

  // User message
  const userMsg = { role: 'user', content: message, timestamp: Date.now() };
  chat.messages.push(userMsg);
  saveChats();

  if (chat.messages.length === 1) {
    els.messagesContainer.innerHTML = '';
  }
  els.messagesContainer.appendChild(createMessageElement(userMsg));

  // Assistant placeholder
  const assistantMsg = { role: 'assistant', content: '', timestamp: Date.now() };
  chat.messages.push(assistantMsg);

  const assistantEl = createMessageElement(assistantMsg);
  const assistantBubble = assistantEl.querySelector('.assistant-bubble');
  els.messagesContainer.appendChild(assistantEl);
  scrollToBottom(true);

  renderHistoryList();

  // State
  isStreaming = true;
  abortController = new AbortController();
  els.stopStreamBtn.style.display = 'inline-flex';
  els.sendBtn.disabled = true;

  const history = chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));

  let fullReply = '';
  let streamError = null;

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, modelName: currentModel }),
      signal: abortController.signal,
    });

    // Không phải SSE (lỗi 4xx/5xx JSON)
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || !ct.includes('text/event-stream')) {
      const raw = await response.text();
      let msg = `HTTP ${response.status}`;
      try { msg = JSON.parse(raw).error || msg; } catch {}
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let rafPending = false;

    const flush = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        assistantBubble.innerHTML = renderMarkdown(fullReply);
        enhanceCodeBlocks(assistantBubble, { addCopyButtons: false });
        if (autoScroll) scrollToBottom(true);
      });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            streamError = new Error(parsed.error);
            break;
          }
          if (parsed.modelUsed && parsed.modelUsed !== currentModel) {
            toast(`Đã fallback sang model: ${parsed.modelUsed}`, 'warning', 4000);
          }
          if (typeof parsed.text === 'string' && parsed.text.length) {
            fullReply += parsed.text;
            assistantMsg.content = fullReply;
            flush();
          }
        } catch (e) {
          console.warn('[SSE] Bad JSON:', data);
        }
      }
      if (streamError) break;
    }

    if (streamError) throw streamError;

    if (!fullReply) fullReply = '_(Không có phản hồi)_';
    assistantMsg.content = fullReply;
    assistantBubble.innerHTML = renderMarkdown(fullReply);
    enhanceCodeBlocks(assistantBubble);

    if (chat.title === message.slice(0, 40) && fullReply) {
      chat.title = fullReply.slice(0, 40).replace(/\n/g, ' ') + (fullReply.length > 40 ? '…' : '');
    }

    // Regenerate button
    const meta = assistantEl.querySelector('.message-actions');
    if (meta && !meta.querySelector('[data-regen]')) {
      const regenBtn = document.createElement('button');
      regenBtn.className = 'mini-icon-btn';
      regenBtn.dataset.regen = '1';
      regenBtn.title = 'Tạo lại';
      regenBtn.innerHTML = '<i class="material-icons">refresh</i>';
      regenBtn.addEventListener('click', regenerateLast);
      meta.appendChild(regenBtn);
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      if (!fullReply) fullReply = '_(Đã dừng)_';
      assistantMsg.content = fullReply;
      assistantBubble.innerHTML = renderMarkdown(fullReply);
      enhanceCodeBlocks(assistantBubble);
    } else {
      console.error('[chat] ❌', err);
      const msg = err.message || 'Lỗi không xác định';
      let displayMsg;
      if (/quá tải|503|high demand/i.test(msg)) {
        displayMsg = `⚠️ **Model đang quá tải tạm thời**\n\nĐợi 10–30 giây rồi thử lại, hoặc đổi model khác.\n\n> ${msg}`;
        toast('Model quá tải, thử lại sau', 'warning', 5000);
      } else if (/rate limit|429|hạn mức/i.test(msg)) {
        displayMsg = `⚠️ **Đã vượt hạn mức**\n\nĐợi 30–60 giây rồi thử lại.\n\n> ${msg}`;
        toast('Đã vượt hạn mức', 'warning', 5000);
      } else if (/API key|401/i.test(msg)) {
        displayMsg = `🔑 **API key không hợp lệ**\n\nKiểm tra lại \`GEMINI_API_KEY\` trong file \`.env\`.\n\n> ${msg}`;
        toast('API key sai', 'error', 5000);
      } else {
        displayMsg = `❌ **${msg}**`;
        toast(`Lỗi: ${msg}`, 'error', 5000);
      }
      assistantMsg.content = displayMsg;
      assistantBubble.innerHTML = renderMarkdown(displayMsg);
    }
  } finally {
    isStreaming = false;
    abortController = null;
    els.stopStreamBtn.style.display = 'none';
    els.sendBtn.disabled = false;
    saveChats();
    renderHistoryList();
    scrollToBottom();
  }
}

function stopStream() {
  if (abortController) abortController.abort();
}

async function regenerateLast() {
  if (isStreaming) return;
  const chat = currentChatId ? chats.get(currentChatId) : null;
  if (!chat || chat.messages.length < 2) return;

  const last = chat.messages[chat.messages.length - 1];
  if (last.role === 'assistant') chat.messages.pop();
  const lastUser = chat.messages[chat.messages.length - 1];
  if (!lastUser || lastUser.role !== 'user') return;

  const userContent = lastUser.content;
  chat.messages.pop();
  saveChats();

  els.userInput.value = userContent;
  const messageEls = els.messagesContainer.querySelectorAll('.message');
  if (messageEls.length >= 2) {
    messageEls[messageEls.length - 1].remove();
    messageEls[messageEls.length - 2].remove();
  }
  sendMessage();
}

/* ============================================================
 *  HISTORY LIST
 * ============================================================ */
function renderHistoryList() {
  els.chatHistoryList.innerHTML = '';
  const query = (els.searchChats.value || '').toLowerCase().trim();

  const items = Array.from(chats.entries())
    .filter(([_, c]) => !query || (c.title || '').toLowerCase().includes(query))
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = query ? 'Không tìm thấy' : 'Chưa có cuộc trò chuyện';
    els.chatHistoryList.appendChild(empty);
    return;
  }

  for (const [id, chat] of items) {
    const item = document.createElement('div');
    item.className = `history-item ${id === currentChatId ? 'active' : ''}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = chat.title || 'Cuộc trò chuyện mới';

    const actions = document.createElement('div');
    actions.className = 'actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'mini-btn';
    renameBtn.title = 'Đổi tên';
    renameBtn.innerHTML = '<i class="material-icons">edit</i>';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt('Tên mới:', chat.title || '');
      if (newName != null && newName.trim()) {
        chat.title = newName.trim();
        saveChats();
        renderHistoryList();
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn';
    delBtn.title = 'Xoá';
    delBtn.innerHTML = '<i class="material-icons">delete_outline</i>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Xoá cuộc trò chuyện này?')) return;
      chats.delete(id);
      if (currentChatId === id) {
        currentChatId = null;
        renderMessages([]);
      }
      saveChats();
      renderHistoryList();
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    item.appendChild(title);
    item.appendChild(actions);

    item.addEventListener('click', () => {
      currentChatId = id;
      renderMessages(chat.messages);
      renderHistoryList();
      if (window.innerWidth <= 768) closeSidebar();
    });

    els.chatHistoryList.appendChild(item);
  }
}

/* ============================================================
 *  CHAT ACTIONS
 * ============================================================ */
function newChat() {
  const cur = currentChatId ? chats.get(currentChatId) : null;
  if (cur && cur.messages.length === 0) {
    renderMessages([]);
    return;
  }
  currentChatId = null;
  renderMessages([]);
  renderHistoryList();
  els.userInput.focus();
}

function clearCurrentChat() {
  if (!currentChatId || !chats.has(currentChatId)) return;
  if (!confirm('Xoá tin nhắn trong cuộc trò chuyện hiện tại?')) return;
  const chat = chats.get(currentChatId);
  chat.messages = [];
  saveChats();
  renderMessages([]);
  renderHistoryList();
}

function exportChat() {
  if (!currentChatId || !chats.has(currentChatId)) {
    toast('Chưa có cuộc trò chuyện', 'warning');
    return;
  }
  const chat = chats.get(currentChatId);
  const data = JSON.stringify({
    id: currentChatId,
    title: chat.title,
    messages: chat.messages,
    exportedAt: new Date().toISOString(),
  }, null, 2);

  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat_${currentChatId}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Đã export', 'success', 1500);
}

function importChat() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.messages || !Array.isArray(data.messages)) {
          throw new Error('File không hợp lệ');
        }
        const id = data.id || Date.now().toString();
        chats.set(id, {
          title: data.title || 'Imported chat',
          messages: data.messages,
          createdAt: Date.now(),
        });
        saveChats();
        currentChatId = id;
        renderMessages(data.messages);
        renderHistoryList();
        toast('Đã import', 'success');
      } catch (err) {
        toast('File không hợp lệ', 'error');
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function clearAllHistory() {
  if (!chats.size) return;
  if (!confirm('Xoá TẤT CẢ cuộc trò chuyện? Hành động này không thể hoàn tác.')) return;
  chats.clear();
  currentChatId = null;
  saveChats();
  renderMessages([]);
  renderHistoryList();
  toast('Đã xoá tất cả', 'success');
}

/* ============================================================
 *  SIDEBAR
 * ============================================================ */
function openSidebar() {
  els.sidebar.classList.add('open');
  els.sidebarBackdrop.classList.add('visible');
}
function closeSidebar() {
  els.sidebar.classList.remove('open');
  els.sidebarBackdrop.classList.remove('visible');
}

/* ============================================================
 *  INPUT
 * ============================================================ */
function autoResize() {
  const t = els.userInput;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

els.userInput.addEventListener('input', autoResize);
els.userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

/* ============================================================
 *  BINDINGS
 * ============================================================ */
els.sendBtn.addEventListener('click', sendMessage);
els.stopStreamBtn.addEventListener('click', stopStream);
els.newChatBtn.addEventListener('click', newChat);
els.clearChatBtn.addEventListener('click', clearCurrentChat);
els.exportChatBtn.addEventListener('click', exportChat);
els.importChatBtn.addEventListener('click', importChat);
els.clearHistoryBtn.addEventListener('click', clearAllHistory);
els.themeToggle.addEventListener('click', toggleTheme);
els.searchChats.addEventListener('input', renderHistoryList);

els.menuToggle.addEventListener('click', openSidebar);
els.closeSidebarBtn.addEventListener('click', closeSidebar);
els.sidebarBackdrop.addEventListener('click', closeSidebar);

window.addEventListener('resize', () => {
  if (window.innerWidth > 768) closeSidebar();
});

// Global error catcher
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledRejection]', e.reason);
});

/* ============================================================
 *  INIT
 * ============================================================ */
(async function init() {
  loadFromStorage();
  await fetchModels();
  renderHistoryList();

  if (chats.size > 0) {
    const firstId = Array.from(chats.keys())[0];
    currentChatId = firstId;
    renderMessages(chats.get(firstId).messages);
    renderHistoryList();
  } else {
    renderWelcomeScreen();
  }
  autoResize();
})();