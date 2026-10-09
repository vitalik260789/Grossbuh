require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // напр. https://grossbuh-bot.onrender.com

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;   // URL веб-приложения Apps Script
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET; // общий секрет, тот же, что в Code.gs

// Таблица «Глеб — взносы» (отдельный Apps Script, привязанный к ней)
const GLEB_SCRIPT_URL = process.env.GLEB_SCRIPT_URL;
const GLEB_SCRIPT_SECRET = process.env.GLEB_SCRIPT_SECRET;
const GLEB_CATEGORY = 'Глеб инвест';

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан в переменных окружения');
  process.exit(1);
}

/* ---------- типы операций ---------- */
// sheetType — значение, уходящее в столбец E (совпадает с уже
// существующим форматом таблицы: там всего два значения).
const TYPES = [
  { key: 'expense', label: 'Расход', sheetType: 'расход' },
  { key: 'income',  label: 'Доход',  sheetType: 'доход' },
  { key: 'savings', label: 'Сбережения', sheetType: 'расход' },
  { key: 'gleb', label: '📈 Фонд Глеба', sheetType: 'расход' }
];

/* ---------- активы Глеба ---------- */
// coingecko — id для подтягивания цены, если цену не указали
const GLEB_ASSETS = [
  { key: 'BTC', label: '₿ BTC', coingecko: 'bitcoin' },
  { key: 'ETH', label: 'Ξ ETH', coingecko: 'ethereum' },
  { key: 'TON', label: '💎 TON', coingecko: 'the-open-network' },
  { key: 'TWT', label: '🛡 TWT', coingecko: 'trust-wallet-token' },
  { key: 'DEP', label: '🏦 Депозит' },
  { key: 'BAL', label: '🔄 Баланс депозита' }
];

/* ---------- категории дохода ---------- */
const INCOME_CATEGORIES = [
  ['Зарплата', '💼'], ['Инвестиции', '📈'], ['Левый доход', '🤑']
];

/* ---------- категории сбережений ---------- */
const SAVINGS_CATEGORIES = [
  ['Сбережения', '💰']
];

/* ---------- категории (правьте список свободно) ---------- */
const CATEGORIES = [
  ['Еда', '🍞'], ['Кафе', '☕'], ['Столовка', '🍽'],
  ['Авто', '🚗'], ['Связь', '🌐'], ['Спорт', '🏃'],
  ['Оля', '👧'], ['Разница в 0', '➖'], ['Подарки', '🎁'],
  ['В никуда', '🕳'], ['Спиртное', '🍷'], ['Гигиена', '🧴'],
  ['Массовый отдых', '🔥'], ['Развлечения', '🎉'], ['Глеб инвест', '📈'],
  ['Инвестиции', '📈'], ['Такси', '🚕'], ['Туризм', '✈️'],
  ['Детское', '🧸'], ['Подписки', '📋'], ['Одежда', '👕'],
  ['Поездки в РБ', '🇧🇾'], ['Минск квартира', '🏢'], ['СТС', '📺'],
  ['Бровки 36', '💅'], ['Айти', '💻'], ['Аптека', '💊'],
  ['В дар', '☀️'], ['Здоровье', '❤️‍🩹'], ['Кофе', '☕']
];

const WEBHOOK_PATH = `/webhook/${TOKEN}`;
const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

/* ---------- запись через Apps Script Web App ---------- */
async function appendRow({ amount, category, note, sheetType }) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    throw new Error('APPS_SCRIPT_URL / APPS_SCRIPT_SECRET не заданы в переменных окружения');
  }
  const today = new Date();
  const dateStr = [
    String(today.getDate()).padStart(2, '0'),
    String(today.getMonth() + 1).padStart(2, '0'),
    today.getFullYear()
  ].join('.');
  const amountStr = amount.toFixed(2).replace('.', ',');

  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('secret', APPS_SCRIPT_SECRET);
  url.searchParams.set('date', dateStr);
  url.searchParams.set('amount', amountStr);
  url.searchParams.set('note', note || '');
  url.searchParams.set('category', category);
  url.searchParams.set('type', sheetType);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'apps script вернул ошибку');
}

/* ---------- запись в таблицу «Глеб — взносы» ---------- */
async function appendGlebRow({ rub, asset, price, units, note }) {
  if (!GLEB_SCRIPT_URL || !GLEB_SCRIPT_SECRET) {
    throw new Error('GLEB_SCRIPT_URL / GLEB_SCRIPT_SECRET не заданы в переменных окружения');
  }
  const url = new URL(GLEB_SCRIPT_URL);
  url.searchParams.set('secret', GLEB_SCRIPT_SECRET);
  url.searchParams.set('rub', String(rub));
  url.searchParams.set('asset', asset);
  if (price != null) url.searchParams.set('price', String(price));
  if (units != null) url.searchParams.set('units', String(units));
  url.searchParams.set('note', note || '');
  const res = await fetch(url.toString());
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'apps script (Глеб) вернул ошибку');
}

async function fetchUsdPrice(coingeckoId) {
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`);
    const j = await r.json();
    return j[coingeckoId] && j[coingeckoId].usd ? j[coingeckoId].usd : null;
  } catch (e) { return null; }
}

const fmtNum = (v, d = 8) => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d });
function glebSummary(s) {
  const a = GLEB_ASSETS.find(x => x.key === s.glebAsset);
  if (s.glebAsset === 'BAL') return `🔄 Фонд Глеба, баланс депозита: ${fmtNum(s.amount, 2)} ₽`;
  let t = `📈 Фонд Глеба: ${fmtNum(s.amount, 2)} ₽ → ${a ? a.label : s.glebAsset}`;
  if (s.units != null) t += `\nКуплено: ${fmtNum(s.units)} ${s.glebAsset}`;
  if (s.price != null) t += ` по $${fmtNum(s.price, 4)}`;
  if (s.note) t += `\nЗаметка: ${s.note}`;
  return t;
}
function confirmKeyboard() {
  return { inline_keyboard: [[
    { text: '✅ Сохранить', callback_data: 'save' },
    { text: '✖ Отмена', callback_data: 'cancel' }
  ]] };
}
function askGlebAsset(chatId, session, messageId) {
  session.step = 'gleb_asset';
  session.type = TYPES.find(t => t.key === 'gleb');
  session.category = GLEB_CATEGORY;
  sessions.set(chatId, session);
  const text = `Фонд Глеба: ${fmtNum(session.amount, 2)} ₽ — куда?`;
  if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: glebAssetKeyboard() });
  return bot.sendMessage(chatId, text, { reply_markup: glebAssetKeyboard() });
}

/* ---------- сессия в памяти (на чат) ---------- */
// step: 'type' | 'amount' | 'category' | 'confirm'
const sessions = new Map();

function typeKeyboard() {
  const btn = t => ({ text: t.label, callback_data: `type:${t.key}` });
  return { inline_keyboard: [TYPES.slice(0, 3).map(btn), TYPES.slice(3).map(btn)] };
}
function glebAssetKeyboard() {
  const rows = [];
  for (let i = 0; i < GLEB_ASSETS.length; i += 2) {
    rows.push(GLEB_ASSETS.slice(i, i + 2).map(a => ({ text: a.label, callback_data: `gasset:${a.key}` })));
  }
  rows.push([{ text: '✖ Отмена', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}
function categoryKeyboard(typeKey) {
  const list = typeKey === 'income' ? INCOME_CATEGORIES
    : typeKey === 'savings' ? SAVINGS_CATEGORIES
    : CATEGORIES;
  const rows = [];
  for (let i = 0; i < list.length; i += 3) {
    rows.push(list.slice(i, i + 3).map(([name, emoji]) =>
      ({ text: `${emoji} ${name}`, callback_data: `cat:${name}` })));
  }
  return { inline_keyboard: rows };
}
function startEntry(chatId) {
  sessions.set(chatId, { step: 'type' });
  bot.sendMessage(chatId, 'Выбери тип операции:', { reply_markup: typeKeyboard() });
}

bot.onText(/\/start/, (msg) => startEntry(msg.chat.id));

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  // Глеб → Гроссбух: сумма в белорусских рублях
  if (session && session.step === 'gb_amount') {
    const m = msg.text.trim().match(/^(\d+(?:[.,]\d+)?)\s*$/);
    if (!m) { bot.sendMessage(chatId, 'Внеси сумму в белорусских рублях, например 37.5, или нажми «Не надо»'); return; }
    try {
      await appendRow({ amount: parseFloat(m[1].replace(',', '.')), category: GLEB_CATEGORY,
        note: [session.glebAsset === 'DEP' ? 'депозит' : session.glebAsset, session.note].filter(Boolean).join(' '),
        sheetType: 'расход' });
      await bot.sendMessage(chatId, 'Записано ✓ (Гроссбух)');
    } catch (e) { console.error(e); await bot.sendMessage(chatId, '⚠️ Гроссбух: ' + e.message); }
    startEntry(chatId);
    return;
  }
  // Гроссбух → Глеб: сумма в рублях
  if (session && session.step === 'gleb_rub') {
    const m = msg.text.trim().match(/^(\d+(?:[.,]\d+)?)\s*$/);
    if (!m) { bot.sendMessage(chatId, 'Пришли сумму в ₽, например 5000, или нажми «Не надо»'); return; }
    askGlebAsset(chatId, { amount: parseFloat(m[1].replace(',', '.')), note: session.note, fromGrossbuh: true });
    return;
  }

  // Глеб: ввод количества монет (и, по желанию, цены)
  if (session && session.step === 'gleb_units') {
    const m = msg.text.trim().replace(/\$/g, '').match(/^(\d+(?:[.,]\d+)?)(?:\s+(\d+(?:[.,]\d+)?))?\s*$/);
    if (!m) {
      bot.sendMessage(chatId, 'Пришлите количество монет, например: 0.0013\nМожно сразу с ценой в $: 0.0013 85000');
      return;
    }
    session.units = parseFloat(m[1].replace(',', '.'));
    session.price = m[2] ? parseFloat(m[2].replace(',', '.')) : null;
    if (session.price == null) {
      const a = GLEB_ASSETS.find(x => x.key === session.glebAsset);
      if (a && a.coingecko) session.price = await fetchUsdPrice(a.coingecko);
    }
    session.step = 'confirm';
    sessions.set(chatId, session);
    bot.sendMessage(chatId, glebSummary(session) + '\nЗаписать?', { reply_markup: confirmKeyboard() });
    return;
  }

  if (!session || session.step !== 'amount') {
    // если пишут сумму без /start — считаем это обычным расходом
    const match = msg.text.trim().match(/^(\d+([.,]\d+)?)\s*(.*)$/);
    if (!match) { startEntry(chatId); return; }
    const type = TYPES[0];
    const amount = parseFloat(match[1].replace(',', '.'));
    const note = match[3] ? match[3].trim() : '';
    sessions.set(chatId, { step: 'category', type, amount, note });
    bot.sendMessage(chatId, `${type.label}: ${amount.toFixed(2)} ${note ? '— ' + note + ' ' : ''}— выбери категорию:`,
      { reply_markup: categoryKeyboard(type.key) });
    return;
  }

  const match = msg.text.trim().match(/^(\d+([.,]\d+)?)\s*(.*)$/);
  if (!match) {
    bot.sendMessage(chatId, 'Не понял сумму. Пришлите число, например: 53.22 или 53.22 протеин');
    return;
  }
  session.amount = parseFloat(match[1].replace(',', '.'));
  session.note = match[3] ? match[3].trim() : '';
  if (session.type && session.type.key === 'gleb') { askGlebAsset(chatId, session); return; }
  session.step = 'category';
  sessions.set(chatId, session);
  bot.sendMessage(
    chatId,
    `${session.type.label}: ${session.amount.toFixed(2)} ${session.note ? '— ' + session.note + ' ' : ''}— выбери категорию:`,
    { reply_markup: categoryKeyboard(session.type.key) }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('type:')) {
    const key = data.slice(5);
    const type = TYPES.find(t => t.key === key);
    sessions.set(chatId, { step: 'amount', type });
    await bot.editMessageText(key === 'gleb'
      ? '📈 Фонд Глеба. Введи сумму взноса в ₽ (можно с заметкой через пробел):'
      : `${type.label}. Теперь введи сумму (можно с заметкой через пробел):`, {
      chat_id: chatId, message_id: query.message.message_id
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('cat:')) {
    const category = data.slice(4);
    const session = sessions.get(chatId);
    if (!session || session.amount == null) {
      bot.answerCallbackQuery(query.id, { text: 'Сессия устарела, нажмите /start' });
      return;
    }
    session.category = category;
    session.step = 'confirm';
    sessions.set(chatId, session);
    await bot.editMessageText(
      `${session.type.label}: ${session.amount.toFixed(2)} ${session.note ? '— ' + session.note + ' ' : ''}— ${category}\nЗаписать?`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Сохранить', callback_data: 'save' },
          { text: '✖ Отмена', callback_data: 'cancel' }
        ]] }
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('gasset:')) {
    const session = sessions.get(chatId);
    if (!session || session.step !== 'gleb_asset') {
      bot.answerCallbackQuery(query.id, { text: 'Сессия устарела, нажмите /start' });
      return;
    }
    const asset = data.slice(7);
    session.glebAsset = asset;
    session.units = null; session.price = null;
    bot.answerCallbackQuery(query.id);
    if (asset === 'DEP' || asset === 'BAL') {
      session.step = 'confirm';
      sessions.set(chatId, session);
      await bot.editMessageText(glebSummary(session) + '\nЗаписать?', {
        chat_id: chatId, message_id: query.message.message_id, reply_markup: confirmKeyboard()
      });
      return;
    }
    session.step = 'gleb_units';
    sessions.set(chatId, session);
    await bot.editMessageText(
      `Фонд Глеба: ${fmtNum(session.amount, 2)} ₽ → ${asset}.\nСколько монет куплено? Например: 0.0013\nМожно сразу с ценой в $: 0.0013 85000 (без цены подставлю текущую)`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    return;
  }

  if (data === 'save') {
    const session = sessions.get(chatId);
    if (!session || !session.category) {
      bot.answerCallbackQuery(query.id, { text: 'Нечего сохранять' });
      return;
    }
    if (session.glebAsset) {
      try {
        await appendGlebRow({ rub: session.amount, asset: session.glebAsset, price: session.price, units: session.units, note: session.note });
      } catch (e) {
        console.error(e);
        bot.answerCallbackQuery(query.id, { text: 'Ошибка записи в таблицу Глеба' });
        await bot.editMessageText('⚠️ Не записано в «Глеб — взносы»: ' + e.message, { chat_id: chatId, message_id: query.message.message_id });
        return;
      }
      bot.answerCallbackQuery(query.id);
      // баланс депозита — не расход; взнос, начатый из Гроссбуха, там уже записан
      if (session.glebAsset === 'BAL' || session.fromGrossbuh) {
        await bot.editMessageText('Записано ✓ («Глеб — взносы»)', { chat_id: chatId, message_id: query.message.message_id });
        startEntry(chatId);
        return;
      }
      sessions.set(chatId, { step: 'gb_amount', glebAsset: session.glebAsset, note: session.note });
      await bot.editMessageText(
        'Записано ✓ («Глеб — взносы»)\nЗаписать и в Гроссбух как расход «' + GLEB_CATEGORY + '»? Внеси сумму в белорусских рублях:',
        { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: 'Не надо', callback_data: 'skip' }]] } }
      );
      return;
    }
    try {
      await appendRow({
        amount: session.amount,
        category: session.category,
        note: session.note,
        sheetType: session.type.sheetType
      });
      await bot.editMessageText('Записано ✓', { chat_id: chatId, message_id: query.message.message_id });
      bot.answerCallbackQuery(query.id);
      if (session.category === GLEB_CATEGORY) {
        sessions.set(chatId, { step: 'gleb_rub', note: session.note });
        bot.sendMessage(chatId, 'Добавить и в фонд Глеба? Пришли сумму в ₽:',
          { reply_markup: { inline_keyboard: [[{ text: 'Не надо', callback_data: 'skip' }]] } });
        return;
      }
      startEntry(chatId); // сразу готовы к следующей записи
    } catch (e) {
      console.error(e);
      bot.answerCallbackQuery(query.id, { text: 'Ошибка записи, попробуйте ещё раз' });
    }
    return;
  }

  if (data === 'skip') {
    await bot.editMessageText(query.message.text || 'Ок', { chat_id: chatId, message_id: query.message.message_id });
    bot.answerCallbackQuery(query.id);
    startEntry(chatId);
    return;
  }

  if (data === 'cancel') {
    await bot.editMessageText('Отменено', { chat_id: chatId, message_id: query.message.message_id });
    bot.answerCallbackQuery(query.id);
    startEntry(chatId);
    return;
  }
});

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('grossbuh-bot is running'));

app.listen(PORT, async () => {
  console.log(`Listening on ${PORT}`);
  if (PUBLIC_URL) {
    try {
      await bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
      console.log('Webhook set to', `${PUBLIC_URL}${WEBHOOK_PATH}`);
    } catch (e) {
      console.error('Failed to set webhook:', e.message);
    }
  } else {
    console.log('PUBLIC_URL не задан — вебхук не установлен автоматически');
  }
});
