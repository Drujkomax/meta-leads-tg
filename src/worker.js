const GRAPH_API = 'https://graph.facebook.com/v22.0';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/webhook') {
      return verifyWebhook(url, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleWebhook(request, env, ctx);
    }

    return new Response('not found', { status: 404 });
  },
};

function verifyWebhook(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

async function handleWebhook(request, env, ctx) {
  const rawBody = await request.text();

  const valid = await verifySignature(rawBody, request.headers.get('x-hub-signature-256'), env.META_APP_SECRET);
  if (!valid) {
    console.log('signature verification failed');
    return new Response('forbidden', { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  ctx.waitUntil(processPayload(payload, env));
  return new Response('ok', { status: 200 });
}

async function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = signatureHeader.slice(7);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function processPayload(payload, env) {
  if (payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value;
      try {
        await processLead(v, env);
      } catch (err) {
        console.log('processLead failed', err.stack || String(err));
        await sendTelegramSafe(env, `⚠️ Ошибка при обработке лида ${v?.leadgen_id}: ${String(err).slice(0, 300)}`);
      }
    }
  }
}

async function processLead(value, env) {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) throw new Error('no leadgen_id in payload');

  const lead = await graphGet(`/${leadgenId}`, {
    fields: 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,is_organic,platform',
  }, env);

  let formName = null;
  if (lead.form_id) {
    try {
      const form = await graphGet(`/${lead.form_id}`, { fields: 'name' }, env);
      formName = form.name;
    } catch (err) {
      console.log('form name fetch failed', String(err));
    }
  }

  const message = formatLeadMessage(lead, formName);
  await Promise.allSettled([
    sendTelegram(env, env.TELEGRAM_PERSONAL_CHAT_ID, message),
    sendTelegram(env, env.TELEGRAM_GROUP_CHAT_ID, message),
  ]).then((results) => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.log(`telegram send #${i} failed`, String(r.reason));
    });
  });
}

async function graphGet(path, params, env) {
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

async function sendTelegram(env, chatId, text) {
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

async function sendTelegramSafe(env, text) {
  try {
    await sendTelegram(env, env.TELEGRAM_PERSONAL_CHAT_ID, text);
  } catch (err) {
    console.log('alert send failed', String(err));
  }
}
