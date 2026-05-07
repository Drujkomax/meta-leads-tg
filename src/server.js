import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const GRAPH_API = 'https://graph.facebook.com/v22.0';
const PORT = Number(process.env.PORT) || 3000;

const env = {
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_PERSONAL_CHAT_ID: process.env.TELEGRAM_PERSONAL_CHAT_ID,
  TELEGRAM_GROUP_CHAT_ID: process.env.TELEGRAM_GROUP_CHAT_ID,
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, 'ok');
    }

    if (req.method === 'GET' && url.pathname === '/webhook') {
      return verifyWebhook(url, res);
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      return handleWebhook(req, res);
    }

    return send(res, 404, 'not found');
  } catch (err) {
    console.log('handler error', err.stack || String(err));
    return send(res, 500, 'internal error');
  }
});

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

function verifyWebhook(url, res) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
    return send(res, 200, challenge ?? '');
  }
  return send(res, 403, 'forbidden');
}

async function handleWebhook(req, res) {
  const rawBody = await readBody(req);

  const valid = verifySignature(rawBody, req.headers['x-hub-signature-256'], env.META_APP_SECRET);
  if (!valid) {
    console.log('signature verification failed');
    return send(res, 403, 'forbidden');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return send(res, 400, 'bad json');
  }

  processPayload(payload).catch((err) => {
    console.log('processPayload failed', err.stack || String(err));
  });

  return send(res, 200, 'ok');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=') || !appSecret) return false;
  const expected = signatureHeader.slice(7);
  const computed = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (computed.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

async function processPayload(payload) {
  if (payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value;
      try {
        await processLead(v);
      } catch (err) {
        console.log('processLead failed', err.stack || String(err));
        await sendTelegramSafe(`⚠️ Ошибка при обработке лида ${v?.leadgen_id}: ${String(err).slice(0, 300)}`);
      }
    }
  }
}

async function processLead(value) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) throw new Error('no leadgen_id in payload');

  const lead = await graphGet(`/${leadgenId}`, {
    fields: 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,is_organic,platform',
  });

  let formName = null;
  if (lead.form_id) {
    try {
      const form = await graphGet(`/${lead.form_id}`, { fields: 'name' });
      formName = form.name;
    } catch (err) {
      console.log('form name fetch failed', String(err));
    }
  }

  const message = formatLeadMessage(lead, formName);
  const results = await Promise.allSettled([
    sendTelegram(env.TELEGRAM_PERSONAL_CHAT_ID, message),
    sendTelegram(env.TELEGRAM_GROUP_CHAT_ID, message),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.log(`telegram send #${i} failed`, String(r.reason));
  });
}

async function graphGet(path, params) {
  const u = new URL(GRAPH_API + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set('access_token', env.META_PAGE_ACCESS_TOKEN);
  const res = await fetch(u);
  const text = await res.text();
  if (!res.ok) throw new Error(`graph ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const FIELD_LABELS = {
  full_name: 'Полное имя',
  first_name: 'Имя',
  last_name: 'Фамилия',
  email: 'Email',
  phone_number: 'Телефон',
  city: 'Город',
  country: 'Страна',
  street_address: 'Адрес',
  state: 'Регион',
  zip_code: 'Индекс',
  company_name: 'Компания',
  job_title: 'Должность',
  date_of_birth: 'Дата рождения',
  gender: 'Пол',
  marital_status: 'Семейное положение',
  relationship_status: 'Семейное положение',
};

function labelFor(name) {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  return name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatLeadMessage(lead, formName) {
  const lines = [];
  lines.push('🆕 <b>Новый лид</b>');
  lines.push('');

  if (formName || lead.form_id) {
    lines.push(`📋 <b>Форма:</b> ${escapeHtml(formName || lead.form_id)}`);
  }
  if (lead.campaign_name) lines.push(`📣 <b>Кампания:</b> ${escapeHtml(lead.campaign_name)}`);
  if (lead.adset_name) lines.push(`🎯 <b>Группа объявлений:</b> ${escapeHtml(lead.adset_name)}`);
  if (lead.ad_name) lines.push(`📌 <b>Объявление:</b> ${escapeHtml(lead.ad_name)}`);
  if (lead.platform) lines.push(`🌐 <b>Платформа:</b> ${escapeHtml(lead.platform)}`);
  if (lead.is_organic) lines.push('🌱 <b>Органический лид</b>');

  lines.push('');
  lines.push('<b>Данные:</b>');
  for (const f of lead.field_data || []) {
    const label = labelFor(f.name);
    const value = (f.values || []).map(escapeHtml).join(', ') || '—';
    lines.push(`• <b>${escapeHtml(label)}:</b> ${value}`);
  }

  if (lead.created_time) {
    lines.push('');
    const dt = new Date(lead.created_time);
    lines.push(`🕐 ${dt.toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' })}`);
  }

  lines.push('');
  lines.push(`<i>ID лида: <code>${escapeHtml(lead.id)}</code></i>`);

  return lines.join('\n');
}

async function sendTelegram(chatId, text) {
  if (!chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram ${chatId} ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendTelegramSafe(text) {
  try {
    await sendTelegram(env.TELEGRAM_PERSONAL_CHAT_ID, text);
  } catch (err) {
    console.log('alert send failed', String(err));
  }
}

server.listen(PORT, () => {
  console.log(`meta-leads-tg listening on :${PORT}`);
});
