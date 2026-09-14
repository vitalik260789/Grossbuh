require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // напр. https://grossbuh-bot.onrender.com

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;   // URL веб-приложения Apps Script
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET; // общий секрет, тот же, что в Code.gs

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
  { key: 'savings', label: 'Сбережения', sheetType: 'расход' }
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
  ['В дар', '☀️'], ['Здоровье', '❤️‍🩹'], ['Кофе', '☕'],
  ['Сбережения', '💰']
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

/* ---------- сессия в памяти (на чат) ---------- */
// step: 'type' | 'amount' | 'category' | 'confirm'
const sessions = new Map();

function typeKeyboard() {
  return { inline_keyboard: [TYPES.map(t => ({ text: t.label, callback_data: `type:${t.key}` }))] };
}
function categoryKeyboard() {
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 3) {
    rows.push(CATEGORIES.slice(i, i + 3).map(([name, emoji]) =>
      ({ text: `${emoji} ${name}`, callback_data: `cat:${name}` })));
  }
  return { inline_keyboard: rows };
}
function startEntry(chatId) {
  sessions.set(chatId, { step: 'type' });
  bot.sendMessage(chatId, 'Выбери тип операции:', { reply_markup: typeKeyboard() });
}

bot.onText(/\/start/, (msg) => startEntry(msg.chat.id));

bot.on('message', (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = sessions.get(chatId);

  if (!session || session.step !== 'amount') {
    // если пишут сумму без /start — считаем это обычным расходом
    const match = msg.text.trim().match(/^(\d+([.,]\d+)?)\s*(.*)$/);
    if (!match) { startEntry(chatId); return; }
    const type = TYPES[0];
    const amount = parseFloat(match[1].replace(',', '.'));
    const note = match[3] ? match[3].trim() : '';
    sessions.set(chatId, { step: 'category', type, amount, note });
    bot.sendMessage(chatId, `${type.label}: ${amount.toFixed(2)} ${note ? '— ' + note + ' ' : ''}— выбери категорию:`,
      { reply_markup: categoryKeyboard() });
    return;
  }

  const match = msg.text.trim().match(/^(\d+([.,]\d+)?)\s*(.*)$/);
  if (!match) {
    bot.sendMessage(chatId, 'Не понял сумму. Пришлите число, например: 53.22 или 53.22 протеин');
    return;
  }
  session.amount = parseFloat(match[1].replace(',', '.'));
  session.note = match[3] ? match[3].trim() : '';
  session.step = 'category';
  sessions.set(chatId, session);
  bot.sendMessage(
    chatId,
    `${session.type.label}: ${session.amount.toFixed(2)} ${session.note ? '— ' + session.note + ' ' : ''}— выбери категорию:`,
    { reply_markup: categoryKeyboard() }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('type:')) {
    const key = data.slice(5);
    const type = TYPES.find(t => t.key === key);
    sessions.set(chatId, { step: 'amount', type });
    await bot.editMessageText(`${type.label}. Теперь введи сумму (можно с заметкой через пробел):`, {
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

  if (data === 'save') {
    const session = sessions.get(chatId);
    if (!session || !session.category) {
      bot.answerCallbackQuery(query.id, { text: 'Нечего сохранять' });
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
      startEntry(chatId); // сразу готовы к следующей записи
    } catch (e) {
      console.error(e);
      bot.answerCallbackQuery(query.id, { text: 'Ошибка записи, попробуйте ещё раз' });
    }
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
