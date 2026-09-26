// ============================================================
// CẤU HÌNH - THAY THÔNG TIN CỦA BẠN VÀO ĐÂY
// ============================================================
const BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";   // Lấy từ @BotFather sau khi /newbot
const ADMIN_ID  = 123456789;                      // ID Telegram của bạn (lấy từ @userinfobot)
const PORT = process.env.PORT || 3000;
// ============================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_DIR = __dirname;
const FILES = {
  products: path.join(DB_DIR, 'products.json'),
  users: path.join(DB_DIR, 'users.json'),
  deposits: path.join(DB_DIR, 'deposits.json'),
  purchases: path.join(DB_DIR, 'purchases.json'),
  settings: path.join(DB_DIR, 'settings.json'),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

if (!fs.existsSync(FILES.products)) writeJSON(FILES.products, []);
if (!fs.existsSync(FILES.users)) writeJSON(FILES.users, {});
if (!fs.existsSync(FILES.deposits)) writeJSON(FILES.deposits, []);
if (!fs.existsSync(FILES.purchases)) writeJSON(FILES.purchases, []);
if (!fs.existsSync(FILES.settings)) writeJSON(FILES.settings, {
  qrImage: '', bankName: '', accountNumber: '', accountHolder: ''
});

// ---- Xác thực dữ liệu Telegram WebApp gửi lên (chống giả mạo) ----
function checkTelegramAuth(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      pairs.push(`${k}=${v}`);
    }
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    return JSON.parse(params.get('user'));
  } catch { return null; }
}

function sendTelegramMessage(chatId, text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  }).catch(e => console.error('Telegram send error:', e));
}

function auth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const user = checkTelegramAuth(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = user;
  next();
}
function adminOnly(req, res, next) {
  if (req.tgUser.id !== ADMIN_ID) return res.status(403).json({ error: 'forbidden' });
  next();
}

function getOrCreateUser(tgUser) {
  const users = readJSON(FILES.users, {});
  const id = String(tgUser.id);
  if (!users[id]) {
    users[id] = {
      id: tgUser.id,
      name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '),
      username: tgUser.username || '',
      balance: 0
    };
    writeJSON(FILES.users, users);
  } else {
    users[id].name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
    users[id].username = tgUser.username || '';
    writeJSON(FILES.users, users);
  }
  return users[id];
}

// Ẩn danh sách key thật khi trả sản phẩm cho khách, chỉ trả số lượng còn lại
function publicProduct(p) {
  const { keys, ...rest } = p;
  return { ...rest, stock: (keys || []).length };
}

// ==================== USER / HỒ SƠ ====================
app.get('/api/me', auth, (req, res) => {
  const user = getOrCreateUser(req.tgUser);
  res.json({ ...user, isAdmin: req.tgUser.id === ADMIN_ID });
});

// ==================== CÀI ĐẶT (QR NGÂN HÀNG) ====================
app.get('/api/settings', (req, res) => {
  res.json(readJSON(FILES.settings, {}));
});
app.put('/api/settings', auth, adminOnly, (req, res) => {
  const { qrImage, bankName, accountNumber, accountHolder } = req.body;
  const settings = { qrImage: qrImage || '', bankName: bankName || '', accountNumber: accountNumber || '', accountHolder: accountHolder || '' };
  writeJSON(FILES.settings, settings);
  res.json(settings);
});

// ==================== SẢN PHẨM ====================
app.get('/api/products', (req, res) => {
  const products = readJSON(FILES.products, []);
  res.json(products.map(publicProduct));
});

app.post('/api/products', auth, adminOnly, (req, res) => {
  const { name, price, image, description } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'missing fields' });
  const products = readJSON(FILES.products, []);
  const product = { id: Date.now().toString(), name, price: Number(price), image: image || '', description: description || '', keys: [] };
  products.push(product);
  writeJSON(FILES.products, products);
  res.json(publicProduct(product));
});

app.delete('/api/products/:id', auth, adminOnly, (req, res) => {
  let products = readJSON(FILES.products, []);
  products = products.filter(p => p.id !== req.params.id);
  writeJSON(FILES.products, products);
  res.json({ ok: true });
});

// ---- Quản lý KEY của một sản phẩm (chỉ admin) ----
app.get('/api/products/:id/keys', auth, adminOnly, (req, res) => {
  const products = readJSON(FILES.products, []);
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p.keys || []);
});

app.post('/api/products/:id/keys', auth, adminOnly, (req, res) => {
  const { keysText } = req.body; // nhiều key, mỗi dòng 1 key
  const products = readJSON(FILES.products, []);
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const newKeys = String(keysText || '').split('\n').map(k => k.trim()).filter(Boolean);
  p.keys = [...(p.keys || []), ...newKeys];
  writeJSON(FILES.products, products);
  res.json({ added: newKeys.length, stock: p.keys.length });
});

app.delete('/api/products/:id/keys', auth, adminOnly, (req, res) => {
  const { key } = req.body; // xoá đúng 1 key theo nội dung
  const products = readJSON(FILES.products, []);
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  p.keys = (p.keys || []).filter(k => k !== key);
  writeJSON(FILES.products, products);
  res.json({ stock: p.keys.length });
});

// ==================== MUA HÀNG (trừ ví, xuất 1 key) ====================
app.post('/api/purchase/:productId', auth, (req, res) => {
  const products = readJSON(FILES.products, []);
  const p = products.find(x => x.id === req.params.productId);
  if (!p) return res.status(404).json({ error: 'Sản phẩm không tồn tại' });
  if (!p.keys || !p.keys.length) return res.status(400).json({ error: 'Sản phẩm đã hết hàng' });

  const users = readJSON(FILES.users, {});
  const id = String(req.tgUser.id);
  const user = users[id] || getOrCreateUser(req.tgUser);
  if (user.balance < p.price) return res.status(400).json({ error: 'Số dư không đủ, vui lòng nạp thêm tiền' });

  const key = p.keys.shift();
  user.balance -= p.price;
  users[id] = user;
  writeJSON(FILES.users, users);
  writeJSON(FILES.products, products);

  const purchases = readJSON(FILES.purchases, []);
  const purchase = {
    id: Date.now().toString(),
    userId: req.tgUser.id,
    userName: user.name,
    productId: p.id,
    productName: p.name,
    price: p.price,
    key,
    createdAt: new Date().toISOString()
  };
  purchases.push(purchase);
  writeJSON(FILES.purchases, purchases);

  sendTelegramMessage(req.tgUser.id, `✅ Mua thành công <b>${p.name}</b>\nKey của bạn: <code>${key}</code>\nSố dư còn lại: ${user.balance.toLocaleString('vi-VN')}đ`);
  sendTelegramMessage(ADMIN_ID, `💰 ${user.name} vừa mua <b>${p.name}</b> (-${p.price.toLocaleString('vi-VN')}đ)`);

  res.json({ ok: true, key, balance: user.balance });
});

// ==================== LỊCH SỬ ĐÃ MUA ====================
app.get('/api/purchases', auth, (req, res) => {
  const purchases = readJSON(FILES.purchases, []);
  if (req.tgUser.id === ADMIN_ID) return res.json(purchases.reverse());
  res.json(purchases.filter(x => x.userId === req.tgUser.id).reverse());
});

// ==================== NẠP TIỀN ====================
app.post('/api/deposits', auth, (req, res) => {
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Số tiền không hợp lệ' });
  const deposits = readJSON(FILES.deposits, []);
  const user = getOrCreateUser(req.tgUser);
  const deposit = {
    id: Date.now().toString(),
    userId: req.tgUser.id,
    userName: user.name,
    username: user.username,
    amount: amt,
    note: note || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  deposits.push(deposit);
  writeJSON(FILES.deposits, deposits);

  sendTelegramMessage(ADMIN_ID, `💳 <b>Yêu cầu nạp tiền mới #${deposit.id}</b>\nKhách: ${user.name} (@${user.username || 'n/a'}) - ID: ${user.id}\nSố tiền: ${amt.toLocaleString('vi-VN')}đ${note ? `\nGhi chú: ${note}` : ''}`);
  res.json(deposit);
});

app.get('/api/deposits', auth, (req, res) => {
  const deposits = readJSON(FILES.deposits, []);
  if (req.tgUser.id === ADMIN_ID) return res.json(deposits.reverse());
  res.json(deposits.filter(x => x.userId === req.tgUser.id).reverse());
});

// Admin duyệt nạp tiền -> cộng tiền vào ví khách
app.put('/api/deposits/:id', auth, adminOnly, (req, res) => {
  const { status } = req.body; // 'approved' | 'rejected'
  const deposits = readJSON(FILES.deposits, []);
  const d = deposits.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.status !== 'pending') return res.status(400).json({ error: 'Yêu cầu đã được xử lý' });
  d.status = status;
  writeJSON(FILES.deposits, deposits);

  if (status === 'approved') {
    const users = readJSON(FILES.users, {});
    const id = String(d.userId);
    if (!users[id]) users[id] = { id: d.userId, name: d.userName, username: d.username, balance: 0 };
    users[id].balance += d.amount;
    writeJSON(FILES.users, users);
    sendTelegramMessage(d.userId, `✅ Nạp tiền thành công! +${d.amount.toLocaleString('vi-VN')}đ vào ví.\nSố dư hiện tại: ${users[id].balance.toLocaleString('vi-VN')}đ`);
  } else {
    sendTelegramMessage(d.userId, `❌ Yêu cầu nạp tiền #${d.id} bị từ chối. Liên hệ admin nếu có thắc mắc.`);
  }
  res.json(d);
});

app.listen(PORT, () => console.log(`✅ Shop mini app đang chạy tại cổng ${PORT}`));
