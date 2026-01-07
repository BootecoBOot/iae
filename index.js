// --- Dependências ---
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const metrics = require('./metrics');
const { saveMessage, upsertUser, getRecentConversation, getUser, upsertManyPrefs, getUserPrefs, getUserStats, getUserTimeSeries, getConversationStats, getConversationTimeSeries, getActiveUserStats, getRecentUsers } = require('./db');
const recommendationEngine = require('./recommendationEngine');

// --- CONFIG ---
console.log('[ENV] Carregando variáveis de ambiente...');
console.log('[ENV] EVOLUTION_URL:', process.env.EVOLUTION_URL ? 'definida' : 'ausente');
console.log('[ENV] EVOLUTION_API_KEY:', process.env.EVOLUTION_API_KEY ? 'definida' : 'ausente');
console.log('[ENV] INSTANCE:', process.env.INSTANCE ? 'definida' : 'ausente');
console.log('[ENV] GOOGLE_MAPS_API_KEY:', process.env.GOOGLE_MAPS_API_KEY ? 'definida' : 'ausente');
console.log('[ENV] GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'definida' : 'ausente');
console.log('[ENV] PORT:', process.env.PORT || 'padrão 3000');

const EVOLUTION_URL = process.env.EVOLUTION_URL;
// Normaliza URL base da Evolution (remove barras finais para evitar "//")
const EV_URL_BASE = String(EVOLUTION_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.INSTANCE;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SECRET_ADMIN = process.env.SECRET_ADMIN || process.env.secret_admin || process.env.SECRET_ADMIN_PANEL;
const GOOGLE_SPEECH_API_KEY = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
const GOOGLE_SPEECH_LANGUAGE = process.env.GOOGLE_SPEECH_LANGUAGE || 'pt-BR';
// Encode instance for safe usage in Evolution API URL paths
const EV_INSTANCE = encodeURIComponent(INSTANCE);

const PERSONA_DIR = path.join(__dirname, 'personas');
const SPONSORED_FILE = path.join(__dirname, 'sponsored.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Evolution capabilities (auto-disabled on first unsupported error)
const EV_CAPS = { presence: true, readReceipt: true };

// --- Small talk detection ---
function isSmallTalk(msg) {
  const m = String(msg || '').toLowerCase();
  const patterns = [
    'como vc esta', 'como voce esta', 'como você está', 'como vai', 'tudo bem', 'td bem', 'beleza',
    'qual seu nome', 'qual o seu nome', 'seu nome', 'quem e voce', 'quem é você', 'quem vc e',
    'o que voce faz', 'o que vc faz', 'quem eh voce', 'quem é vc',
    'obrigado', 'valeu', 'brigado', 'obg', 'agradecido',
    'bom dia', 'boa tarde', 'boa noite'
  ];
  return patterns.some(p => m.includes(p));
}

// --- Transcrição de áudio (Google Speech-to-Text) ---
async function transcribeAudioWithGoogle(base64Audio, mimetype) {
  try {
    if (!GOOGLE_SPEECH_API_KEY) {
      console.warn('[AUDIO] GOOGLE_SPEECH_API_KEY não configurada; ignorando áudio');
      return null;
    }
    const isOgg = (mimetype || '').toLowerCase().includes('ogg');
    const encoding = isOgg ? 'OGG_OPUS' : 'ENCODING_UNSPECIFIED';
    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(GOOGLE_SPEECH_API_KEY)}`;
    const payload = {
      config: {
        encoding,
        languageCode: GOOGLE_SPEECH_LANGUAGE,
        // Para OGG_OPUS o Google exige sampleRateHertz explícito (em geral 48000 Hz)
        sampleRateHertz: isOgg ? 48000 : undefined,
        enableAutomaticPunctuation: true,
      },
      audio: { content: base64Audio },
    };
    const resp = await axios.post(url, payload, { timeout: 10000 });
    try {
      console.log('[AUDIO][DEBUG] Resposta bruta do Google STT:', JSON.stringify(resp.data));
    } catch (_) {}
    const results = resp.data?.results;
    if (!Array.isArray(results) || results.length === 0) {
      try { console.warn('[AUDIO][DEBUG] Google STT retornou results vazio para o áudio'); } catch (_) {}
      return null;
    }
    const alt = results[0].alternatives?.[0];
    const transcript = (alt?.transcript || '').trim();
    if (!transcript) {
      try { console.warn('[AUDIO][DEBUG] Google STT retornou alternativa sem transcript de texto'); } catch (_) {}
      return null;
    }
    return transcript;
  } catch (err) {
    try { console.error('[AUDIO] Erro ao transcrever áudio:', err?.response?.data || err?.message || err); } catch (_) {}
    return null;
  }
}

async function handleSmallTalk(recipientId, userMessage) {
  const hint = `Você é a I.aê, uma IA parceira de rolê que vive dentro do WhatsApp.\n` +
    `Responda de forma breve, simpática e humana, parecendo uma pessoa conversando.\n` +
    `Regras específicas:\n` +
    `- Se perguntarem QUEM É VOCÊ (quem é vc, o que você faz, etc.), explique que é a I.aê, uma inteligência artificial feita pra ajudar a encontrar bares e restaurantes do jeito da pessoa, salvando preferências pra ir aprendendo o gosto dela. Diga que também consegue trocar ideia e tirar dúvidas simples, mas sempre com foco em ajudar no rolê.\n` +
    `- Se perguntarem COMO VOCÊ ESTÁ, responda algo leve (tipo "tô on", "tô na atividade"), e diga que tá pronta pra ajudar a achar um lugar ou trocar ideia.\n` +
    `- Se for só cumprimento (oi, bom dia, boa tarde, boa noite), responda o cumprimento e diga rapidamente o que você é e que pode ajudar a achar bar/restaurante quando a pessoa quiser.\n` +
    `- Não invente informações sobre você (não diga que tem paladar, fome, sede, etc.).\n` +
    `- Não force recomendação nem peça localização nessa resposta. No máximo, convide a pessoa a te pedir um bar ou restaurante quando quiser, de forma natural.`;
  const reply = await sendAdaptive(recipientId, hint);
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  userState[recipientId].conversationHistory.push({ role: 'bot', message: reply });
  return true;
}

// --- Validação de variáveis de ambiente ---
function validateEnvOrExit() {
  const required = {
    EVOLUTION_URL,
    EVOLUTION_API_KEY,
    INSTANCE,
    GOOGLE_MAPS_API_KEY,
    GEMINI_API_KEY,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || String(v).trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Configuração ausente no .env: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// --- Helper: enviar resposta adaptativa usando uma dica/objetivo ---
async function sendAdaptive(recipientId, hint) {
  try {
    console.log('[DEBUG] Enviando resposta adaptativa para:', hint.substring(0, 50) + (hint.length > 50 ? '...' : ''));
    
    // Tenta gerar uma resposta adaptativa
    const reply = await generateAdaptiveReply(recipientId, hint);
    
    // Se não houver resposta ou ocorrer um erro, usa uma resposta padrão
    if (!reply) {
      console.log('[DEBUG] Nenhuma resposta adaptativa gerada, usando resposta padrão');
      const name = getUserName(recipientId) || 'parceiro';
      const defaultReply = `Beleza, ${name}! Não peguei exatamente tudo que você quis dizer, mas tô aqui pra te ajudar com bares e restaurantes. Me explica rapidinho do seu jeito o que você tá buscando agora.`;
      await sendMessage(recipientId, defaultReply);
      return defaultReply;
    }
    
    // Envia a resposta gerada
    await sendMessage(recipientId, reply);
    return reply;
    
  } catch (error) {
    console.error('[ERROR] Erro em sendAdaptive:', error.message);
    const name = getUserName(recipientId) || 'parceiro';
    const errorReply = `Ops, ${name}! Tive um probleminha aqui, mas já estou me recuperando. Pode repetir o que você disse?`;
    await sendMessage(recipientId, errorReply);
    return errorReply;
  }
}

// --- Geração de resposta adaptativa por Gemini ---
async function generateAdaptiveReply(wa_jid, userMessage) {
  // Primeiro tenta entender se é um pedido de bar/restaurante usando NLU (parseInitialIntent)
  try {
    const persona = personasCache[wa_jid] || {};
    const parsed = await parseInitialIntent(userMessage, persona);
    const intent = parsed?.intention;

    if (intent === 'bar' || intent === 'restaurante') {
      const name = getUserName(wa_jid) || 'parceiro';
      const tipo = intent === 'bar' ? 'um bar' : 'um restaurante';
      // Aqui entendemos que a pessoa já falou o tipo (ex.: "restaurante com comida de vó").
      // Em vez de perguntar de novo "bar ou restaurante", avançamos pedindo localização/bairro.
      return `Show, ${name}! Entendi que você quer ${tipo} com essa vibe que comentou. Me diz agora em qual bairro/cidade você quer ou então me manda a sua localização que eu procuro opções pra você.`;
    }
  } catch (_) {}

  // Se o Gemini estiver indisponível, retorna null para usar respostas padrão
  if (!model) return null;

  try {
    // Cria um prompt simples
    const prompt = `Usuário: ${userMessage}\nResponda de forma objetiva em até 2 frases.`;
    
    // Tenta gerar uma resposta com timeout curto
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    try {
      const r = await model.generateContent(prompt, { signal: controller.signal });
      clearTimeout(timeoutId);
      return (await r.response.text()).trim() || 'Fechado!';
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  } catch (e) {
    console.error('[GEMINI] Erro:', e.message);
    return null; // Retorna null para usar respostas padrão
  }
}

// --- Resolve Evolution instanceId por destinatário ---
function resolveInstanceIdFor(to) {
  try {
    const key = String(to || '');
    const st = userState[key];
    return (st && st.instanceId) ? st.instanceId : EV_INSTANCE;
  } catch (_) {
    return EV_INSTANCE;
  }
}

// Validação de ambiente com delay para container
setTimeout(() => {
  validateEnvOrExit();
}, 5000);

// --- Utilidades de intenção: seleção e pedidos de informação ---
function parseSelectionIndex(text) {
  try {
    const t = String(text || '').toLowerCase();
    // números explícitos
    const m = t.match(/\b([123])\b/);
    if (m) return parseInt(m[1], 10);
    // palavras
    if (/(primeir|1\s*o)/.test(t)) return 1;
    if (/(segund|2\s*o)/.test(t)) return 2;
    if (/(terceir|3\s*o)/.test(t)) return 3;
  } catch (_) {}
  return null;
}

function detectInfoIntent(text) {
  try {
    const t = String(text || '').toLowerCase();
    const intents = [
      { key: 'price', re: /(preço|preco|quanto custa|faixa de preço|valor)/ },
      { key: 'hours', re: /(horário|horario|abre|fecha|funciona|aberto|fechado)/ },
      { key: 'phone', re: /(telefone|whatsapp|contato)/ },
      { key: 'website', re: /(site|cardápio|cardapio|link)/ },
      { key: 'address', re: /(endereço|endereco|como chegar|onde fica|aonde fica)/ },
    ];
    for (const it of intents) { if (it.re.test(t)) return it.key; }
  } catch (_) {}
  return null;
}

function mapPriceLevel(priceLevel) {
  const lvl = typeof priceLevel === 'number' ? priceLevel : NaN;
  if (isNaN(lvl)) return null;
  const map = {
    0: null, // desconhecido
    1: 'Faixa de preço: econômico (💸)',
    2: 'Faixa de preço: moderado (💵)',
    3: 'Faixa de preço: caro (💰)',
    4: 'Faixa de preço: luxo (👑)',
  };
  return map[lvl] || null;
}

function buildMapsLink(place) {
  try {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.place_id}`;
  } catch (_) { return ''; }
}

function formatInfoReply(place, details, topic) {
  const name = place?.name || 'o lugar';
  const link = buildMapsLink(place);
  const header = `*${name}*\n🔗 ${link}`;

  const sponsor = (sponsored || []).find(s => s.place_id === place?.place_id && s.active);

  switch (topic) {
    case 'price': {
      const msg = mapPriceLevel(place?.price_level);
      let out = msg ? `${header}\n${msg}` : `${header}\nNão encontrei faixa de preço no perfil do Google desse lugar.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
    }
    case 'hours': {
      const oh = details?.opening_hours;
      if (oh?.weekday_text && Array.isArray(oh.weekday_text) && oh.weekday_text.length) {
        const lines = oh.weekday_text.join('\n');
        const now = (oh?.open_now === true) ? '\nStatus: aberto agora ✅' : (oh?.open_now === false) ? '\nStatus: fechado agora ❌' : '';
        let out = `${header}\nHorários:\n${lines}${now}`;
        const extra = composePartnerDetails(sponsor, place, details);
        if (extra) out += extra;
        return out;
      }
      let out = `${header}\nNão encontrei horários de funcionamento no perfil do Google desse lugar.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
    }
    case 'phone': {
      const phone = details?.formatted_phone_number || details?.international_phone_number;
      let out = phone ? `${header}\nTelefone: ${phone}` : `${header}\nNão encontrei telefone no perfil do Google desse lugar.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
    }
    case 'website': {
      const site = details?.website || details?.url;
      let out = site ? `${header}\nSite/Cardápio: ${site}` : `${header}\nNão encontrei site ou cardápio no perfil do Google desse lugar.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
    }
    case 'address': {
      const addr = details?.formatted_address || place?.vicinity;
      let out = addr ? `${header}\nEndereço: ${addr}` : `${header}\nNão encontrei endereço detalhado no perfil do Google desse lugar.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
    }
    default:
      let out = `${header}\nMe diga o que você quer saber: preço, horário, telefone ou site.`;
      const extra = composePartnerDetails(sponsor, place, details);
      if (extra) out += extra;
      return out;
  }
}

// --- Distância geográfica (haversine) e filtro por proximidade ---
function haversineKm(lat1, lon1, lat2, lon2) {
  function toRad(d) { return (d * Math.PI) / 180; }
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function filterByDistance(places, centerLat, centerLng, maxKm = 15) {
  console.log(`[DISTANCE] Filtrando lugares a até ${maxKm}km de (${centerLat}, ${centerLng})`);
  const out = [];
  let invalidCount = 0;
  let outOfRangeCount = 0;
  let keptCount = 0;
  
  for (const p of places || []) {
    const plat = p.geometry?.location?.lat;
    const plng = p.geometry?.location?.lng;
    
    if (typeof plat !== 'number' || typeof plng !== 'number') {
      console.log(`[DISTANCE] Lugar sem coordenadas: ${p.name || 'Sem nome'} (${p.place_id})`);
      invalidCount++;
      out.push(p); // Mantém por segurança
      continue;
    }
    
    const d = haversineKm(centerLat, centerLng, plat, plng);
    console.log(`[DISTANCE] ${p.name} - Distância: ${d.toFixed(2)} km`);
    
    if (d <= maxKm) {
      out.push(p);
      keptCount++;
    } else {
      outOfRangeCount++;
    }
  }
  
  console.log(`[DISTANCE] Resultado do filtro: ${keptCount} mantidos, ${outOfRangeCount} fora do raio, ${invalidCount} sem coordenadas`);
  return out;
}

// Configuração do Gemini com tratamento de erro
let genAI;
let model;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || '0.2');

try {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  generationConfig: {
    temperature: isNaN(GEMINI_TEMPERATURE) ? 0.2 : GEMINI_TEMPERATURE,
    topP: 0.9
  }
});
} catch (e) {
  console.error('[GEMINI] Erro ao configurar o modelo:', e.message);
  model = null;
}

// --- Preferências recorrentes: aprendizado simples a partir das mensagens ---
function derivePrefsFromMessage(msg) {
  const m = String(msg || '').toLowerCase();
  const prefs = {};
  if (m.includes('chopp') || m.includes('chope')) prefs.prefers_chopp = 'true';
  if (m.includes('cerveja')) prefs.prefers_cerveja = 'true';
  if (m.includes('happy hour') || m.includes('happyhour')) prefs.prefers_happy_hour = 'true';
  if (m.includes('musica ao vivo') || m.includes('música ao vivo') || m.includes('ao vivo')) prefs.prefers_musica_ao_vivo = 'true';
  if (m.includes('samba') || m.includes('pagode') || m.includes('rock') || m.includes('sertanejo')) prefs.prefers_musica = 'true';
  if (m.includes('pub') || m.includes('boteco') || m.includes('barzinho')) prefs.prefers_bar_estilo = 'true';
  if (m.includes('rodizio') || m.includes('rodízio')) prefs.prefers_rodizio = 'true';
  // Guarda última keyword livre (para referência futura)
  const filters = extractSearchFilters(m);
  const lastKw = filters?.filters?.keyword || filters?.keyword;
  if (lastKw) prefs.last_freeform_keyword = lastKw;
  return prefs;
}

async function learnPreferences(recipientId, userMessage) {
  try {
    const prefs = derivePrefsFromMessage(userMessage);
    const keys = Object.keys(prefs || {});
    if (keys.length > 0) await upsertManyPrefs(recipientId, prefs);
  } catch (_) {}
}

// --- Estado em memória ---
const userState = {};
const personasCache = {};
let sponsored = [];

// --- Cache de detalhes de lugares (TTL) ---
// Armazena { details, ts } por place_id para reduzir custo/latência de chamadas
const placeDetailsCache = {};
const PLACE_DETAILS_TTL_MS = parseInt(process.env.PLACE_DETAILS_TTL_MS || '86400000'); // padrão 24h
// Tempo para considerar que a conversa foi retomada após inatividade (padrão 48h)
const RESUME_GREET_MS = parseInt(process.env.RESUME_GREET_MS || '172800000');
// Raio padrão (km) para parceiros próximos por localização
const SPONSORED_NEAR_KM = parseInt(process.env.SPONSORED_NEAR_KM || '5');

// Persist user name into persona cache and file
function setUserName(recipientId, name) {
  try {
    const safe = String(name || '').trim();
    if (!safe) return;
    const personaPath = path.join(PERSONA_DIR, `${recipientId}.json`);
    const existing = personasCache[recipientId] || {};
    const updated = { ...existing, nome: safe };
    personasCache[recipientId] = updated;
    fs.writeFileSync(personaPath, JSON.stringify(updated, null, 2));
    // Persist also in DB
    try { upsertUser(recipientId, { name: safe }); } catch (_) {}
  } catch (e) {
    console.error(`Erro ao salvar nome do usuário ${recipientId}: ${e.message}`);
  }
}

// --- Tipos permitidos/banidos para maior precisão ---
const ALLOWED_TYPES = {
  bar: new Set(['bar', 'pub', 'night_club']),
  restaurante: new Set(['restaurant', 'cafe']),
};
const EXCLUDED_TYPES = new Set([
  'bakery','beauty_salon','store','supermarket','gas_station','lodging','pharmacy','church','place_of_worship','school','university','hospital','doctor','dentist','veterinary_care','gym','car_repair','car_wash','hair_care','laundry','finance','atm','bank','real_estate_agency','lawyer','accounting','local_government_office'
]);

function filterPlacesByType(places, domain) {
  console.log(`[FILTER] Iniciando filtro para domínio: ${domain}`);
  const allowed = ALLOWED_TYPES[domain] || new Set();
  console.log(`[FILTER] Tipos permitidos:`, Array.from(allowed));
  
  const filtered = (places || []).filter((p, index) => {
    console.log(`[FILTER] Processando lugar ${index + 1}/${places?.length || 0}: ${p.name} (${p.place_id})`);
    
    // Exclui empresas não operacionais
    if (p.business_status && p.business_status !== 'OPERATIONAL') {
      console.log(`[FILTER]   - Descartado: business_status = ${p.business_status}`);
      return false;
    }
    
    // Exige identificadores mínimos válidos
    if (!p.place_id || !p.name) {
      console.log(`[FILTER]   - Descartado: place_id ou name ausente`);
      return false;
    }

    const types = new Set(p.types || []);
    console.log(`[FILTER]   - Tipos do lugar:`, Array.from(types));
    
    // Exclui claramente indesejados
    for (const t of types) {
      if (EXCLUDED_TYPES.has(t)) {
        console.log(`[FILTER]   - Descartado: tipo excluído '${t}'`);
        return false;
      }
    }
    
    // Exige interseção com tipos permitidos
    for (const t of types) {
      if (allowed.has(t)) {
        console.log(`[FILTER]   - Aceito: tipo permitido '${t}'`);
        return true;
      }
    }
    
    console.log(`[FILTER]   - Descartado: nenhum tipo permitido encontrado`);
    return false;
  });
  
  console.log(`[FILTER] Filtro concluído. ${filtered.length} de ${places?.length || 0} lugares mantidos`);
  return filtered;
}

// --- Helpers de personalização ---
function getUserName(recipientId) {
  const p = personasCache[recipientId] || {};
  // Se ainda em entrevista, tenta pegar o nome das respostas parciais
  const interview = userState[recipientId]?.interview;
  const interimName = interview?.answers?.nome;
  return p.nome || p.bar?.nome || p.rest?.nome || interimName || null;
}

function shortText(t, max = 60) {
  if (!t) return '';
  const s = String(t).trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// --- Logger central ---
function logErr(ctx, err) {
  try {
    const msg = err?.response?.data?.message || err?.message || String(err);
    const status = err?.response?.status;
    if (status) console.error(`[ERR][${ctx}] status=${status} msg=${msg}`);
    else console.error(`[ERR][${ctx}] ${msg}`);
  } catch (_) {
    try { console.error(`[ERR][${ctx}] (failed to format error)`); } catch (_) {}
  }
}

// --- Onboarding básico ---
// Fluxo de onboarding/entrevista foi descontinuado. Mantemos as funções apenas
// por compatibilidade, mas elas não devem mais disparar perguntas nem mudar estado.
function onboardingAskChoice(recipientId) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  userState[recipientId].awaiting_onboarding_choice = false;
  return Promise.resolve();
}

function onboardingStart(recipientId) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  delete userState[recipientId].onboarding;
  return Promise.resolve();
}

function normalizeAnswer(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
}

// Mood detection and tone
function detectMoodSimple(text) {
  const t = (text || '').toLowerCase();
  const happy = ['feliz','legal','show','top','massa','yay','uhul','obrigado','valeu','bom demais','😍','😄','😀','😃','😁','😊'];
  const sad = ['triste','chateado','depress','deprim','mal','péssimo','pessimo','😢','😭','☹','🙁'];
  const tired = ['cansado','cansada','exausto','exausta','sem energia','pregui','😪','🥱'];
  const angry = ['bravo','brava','puto','puta','irritado','irritada','raiva','poxa','pqp','aff','😠','😡'];
  const hasAny = (arr) => arr.some(w => t.includes(w));
  if (hasAny(happy)) return 'feliz';
  if (hasAny(sad)) return 'triste';
  if (hasAny(tired)) return 'cansado';
  if (hasAny(angry)) return 'irritado';
  return 'neutro';
}

async function detectMoodLLM(text) {
  try {
    const prompt = `Classifique o humor do usuário como exatamente um destes valores: feliz | triste | cansado | irritado | neutro. Responda somente a palavra. Texto: "${text}"`;
    const r = await Promise.race([
      model.generateContent(prompt),
      new Promise((resolve) => setTimeout(() => resolve(null), 1200))
    ]);
    if (!r) return null;
    const ans = (await r.response.text()).trim().toLowerCase();
    if (['feliz','triste','cansado','irritado','neutro'].includes(ans)) return ans;
    return null;
  } catch (_) { return null; }
}

async function detectAndUpdateMood(recipientId, text) {
  const simple = detectMoodSimple(text);
  let mood = simple;
  if (mood === 'neutro') {
    const llm = await detectMoodLLM(text);
    if (llm) mood = llm;
  }
  const now = Date.now();
  const prev = userState[recipientId]?.mood;
  if (prev && prev.value !== 'neutro' && mood === 'neutro' && (now - prev.ts) < 30 * 60 * 1000) {
    userState[recipientId].mood = prev;
  } else {
    if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
    userState[recipientId].mood = { value: mood, ts: now };
  }
}

function tonePrefix(recipientId) {
  const m = userState[recipientId]?.mood?.value || 'neutro';
  if (m === 'feliz') return 'Que bom te ver animadx! ';
  if (m === 'triste') return 'Sinto que as coisas não estão fáceis. Tô aqui pra te ajudar. ';
  if (m === 'cansado') return 'Tô contigo. Vamos facilitar sua vida agora. ';
  if (m === 'irritado') return 'Beleza, vou ser direto e rápido. ';
  return '';
}

async function handleOnboardingChoice(recipientId, userMessage) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  userState[recipientId].awaiting_onboarding_choice = false;
  return false;
}

async function handleOnboardingStep(recipientId, userMessage) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  delete userState[recipientId].onboarding;
  return false;
}

async function handleOnboardingConfirm(recipientId, userMessage) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  delete userState[recipientId].onboarding;
  return false;
}

// --- Heurísticas de reset ---
function isGreeting(msg) {
  const m = (msg || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const tokens = m.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  const greet = new Set(['oi','ola','olaa','opa','eai','eaee','bom','boa','hello','hi']);
  // combinações comuns
  if (tokens.length <= 3 && (tokens.some(t => greet.has(t)) || m.includes('boa noite') || m.includes('bom dia') || m.includes('boa tarde'))) return true;
  return false;
}

function clearUserFlow(uid) {
  if (!userState[uid]) return;
  delete userState[uid].refinement;
  delete userState[uid].awaiting_location_type;
  delete userState[uid].awaiting_location_text;
  delete userState[uid].awaitingLocation;
  delete userState[uid].awaiting_filter;
  delete userState[uid].cta;
  delete userState[uid].awaiting_intent_choice;
  delete userState[uid].awaiting_name;
  delete userState[uid].onboarding;
  delete userState[uid].awaiting_onboarding_choice;
}

// --- Sanitização para persistência em persona (evita referências circulares) ---
function sanitizeForPersona(obj) {
  const allowed = new Set([
    'nome','tipo_bar','ambiente','bebida_preferida','comida','musica','preco',
    'cozinha','ocasião','ocasi_o','restricoes','bebida','openNow','keyword',
    'q1','q2','q3'
  ]);
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!allowed.has(k)) continue;
    if (v == null) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') out[k] = v;
  }
  return out;
}

// --- Detecção de reset via IA ---
async function detectResetIntent(message) {
  try {
    const prompt = `Você é um classificador. Receba uma mensagem do usuário e responda apenas com "reset" se a mensagem indicar cumprimento inicial, reinício de conversa ou desejo de começar do zero (ex.: oi, olá, boa noite, vamos recomeçar, novo começo, start over, reset), ou "nao" caso contrário. Mensagem: "${message}".`;
    const r = await Promise.race([
      model.generateContent(prompt),
      new Promise((resolve) => setTimeout(() => resolve(null), 1200))
    ]);
    if (!r) return null;
    const t = (await r.response.text()).trim().toLowerCase();
    return t.includes('reset');
  } catch (_) {
    return false;
  }
}

// --- Bridges humanizados (sem repetir literalmente a resposta) ---
function includesAny(text, arr) {
  const t = (text || '').toLowerCase();
  return arr.some(w => t.includes(w));
}

function bridgeFromInterview(prevKey, answer, name = 'parceiro') {
  const a = (answer || '').toLowerCase();
  if (prevKey === 'tipo_bar') {
    if (includesAny(a, ['pub'])) return `Um pub é uma ótima pedida pra curtir com os amigos, ${name}.`;
    if (includesAny(a, ['boteco'])) return `Um boteco raiz sempre tem aquela vibe boa, ${name}.`;
    if (includesAny(a, ['balada', 'night'])) return `Algo mais balada pra noite render, né ${name}?`;
  }
  if (prevKey === 'ambiente') {
    if (includesAny(a, ['agitado'])) return `Então você curte um clima mais agitado, ${name}.`;
    if (includesAny(a, ['tranquilo'])) return `Prefere um lugar mais tranquilo pra conversar, ${name}.`;
    if (includesAny(a, ['sofisticado'])) return `Algo mais sofisticado combina com você, ${name}.`;
    if (includesAny(a, ['música', 'musica'])) return `Com música ao vivo fica top, ${name}.`;
  }
  if (prevKey === 'bebida_preferida') {
    if (includesAny(a, ['chopp', 'cerveja'])) return `Um bom chopp gelado nunca falha, ${name}.`;
    if (includesAny(a, ['vinho'])) return `Um vinho cai muito bem, ${name}.`;
    if (includesAny(a, ['drink', 'coquetel'])) return `Uns drinks caprichados são sua praia, ${name}.`;
  }
  if (prevKey === 'comida') {
    if (includesAny(a, ['porção', 'porcao'])) return `Petiscar umas porções é sempre sucesso, ${name}.`;
    if (includesAny(a, ['sanduíche', 'sanduiche', 'burger'])) return `Um bom sanduíche acompanha bem, ${name}.`;
    if (includesAny(a, ['boteco'])) return `Comida de boteco é aquela delícia, ${name}.`;
  }
  if (prevKey === 'musica') {
    if (includesAny(a, ['rock'])) return `Rockzinho ao vivo anima a noite, ${name}.`;
    if (includesAny(a, ['mpb'])) return `Uma MPB dá o clima, ${name}.`;
    if (includesAny(a, ['sertanejo'])) return `Sertanejo pra cantar junto, ${name}.`;
    if (includesAny(a, ['dj'])) return `Com DJ fica mais dançante, ${name}.`;
    if (includesAny(a, ['sem', 'silêncio', 'silencio'])) return `Sem música pra um papo tranquilo, ${name}.`;
  }
  if (prevKey === 'preco') {
    if (includesAny(a, ['econ', 'barato'])) return `Vamos mirar no bom e barato, ${name}.`;
    if (includesAny(a, ['moder'])) return `Algo no meio‑termo, sem exagero, ${name}.`;
    if (includesAny(a, ['lux', 'caro'])) return `Uma experiência mais premium, ${name}.`;
  }
  return `Show, ${name}! Entendi seu estilo.`;
}

function bridgeFromRefinement(step, answer, name = 'parceiro') {
  const a = (answer || '').toLowerCase();
  if (step === 0) {
    if (includesAny(a, ['agitado'])) return `Clima mais agitado então, ${name}.`;
    if (includesAny(a, ['tranquilo'])) return `Mais sossegado, boa, ${name}.`;
  }
  if (step === 1) {
    if (includesAny(a, ['amig', 'galera'])) return `Vai com a galera, legal, ${name}.`;
    if (includesAny(a, ['sozinh', 'solo'])) return `Rolê solo, de boas, ${name}.`;
    if (includesAny(a, ['casal', 'encontro'])) return `Climinha de encontro, capricho nisso, ${name}.`;
  }
  if (step === 2) {
    if (includesAny(a, ['música', 'musica'])) return `Música ao vivo entra no radar, ${name}.`;
    if (includesAny(a, ['sossego', 'silenc'])) return `Algo mais sossegado, entendido, ${name}.`;
  }
  return `Feito, ${name}.`;
}

// --- Extração de filtros de busca (happy hour, aberto agora) ---
function extractSearchFilters(message) {
  const m = (message || '').toLowerCase();
  const filters = {};
  // Abreviações de aberto agora
  if (m.includes('aberto agora') || m.includes('open now')) {
    filters.openNow = true;
  }
  // Geração genérica de keyword a partir do critério do usuário
  const keyword = buildKeywordFromMessage(m);
  if (keyword) filters.keyword = keyword;
  // Filtros de promoções e bebidas
  const kw = new Set();
  if (m.includes('happy hour') || m.includes('happyhour')) kw.add('happy hour');
  if (m.includes('chopp') || m.includes('chope') || m.includes('cerveja')) kw.add('chopp');
  if (m.includes('promo') || m.includes('desconto') || m.includes('oferta')) kw.add('promoção');
  if (m.includes('rodizio') || m.includes('rodízio')) kw.add('rodízio');
  if (m.includes('petisco') || m.includes('tira-gosto') || m.includes('porcao') || m.includes('porção')) kw.add('petiscos');
  // Música/ambiente
  if (m.includes('musica') || m.includes('música') || m.includes('ao vivo') || m.includes('live')) kw.add('música ao vivo');
  if (m.includes('samba') || m.includes('pagode') || m.includes('rock') || m.includes('sertanejo')) kw.add('música');
  // Tipo de lugar
  if (m.includes('pub') || m.includes('boteco') || m.includes('barzinho')) kw.add('bar');
  if (m.includes('gourmet') || m.includes('bistrô') || m.includes('bistro')) kw.add('gourmet');

  if (kw.size > 0) {
    const joined = Array.from(kw).join(' ');
    if (!filters.filters) filters.filters = {};
    filters.filters.keyword = joined;
  }
  return filters;
}

function buildKeywordFromMessage(m) {
  // Remove URLs, números isolados e pontuação comum
  let text = (m || '').replace(/https?:\/\/\S+/g, ' ').replace(/\d+/g, ' ').replace(/["'`.,!?;:()\[\]{}]/g, ' ');
  // Stopwords e termos de domínio/localização que não ajudam no keyword
  const stop = new Set([
    'eu','quero','queria','to','tô','estou','procuro','preciso','me','um','uma','de','do','da','no','na','em','por','pra','para','com','sem','e','ou','mais','menos','bem','mim','agora','hoje','amanhã','amanha','perto','aqui','proximo','próximo','onde','dica','dicas',
    'bar','bares','barzinho','pub','boteco','restaurante','restaurantes','restô','resto','lugar','lugares','perto','mim'
  ]);
  const tokens = text
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t.length > 2 && !stop.has(t));
  // Junta termos restantes como uma expressão simples; se vazio, retorna ''
  const keyword = tokens.join(' ').trim();
  return keyword || '';
}

// --- Filtro simples para pedidos relacionados a futebol/jogos ---
function detectFootballFilter(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('futebol') ||
    m.includes('jogo') ||
    m.includes('jogos') ||
    m.includes('partida') ||
    m.includes('tel e3o') ||
    m.includes('telao')
  );
}

// --- Carregar personas e patrocinados ---
function loadPersonasIntoCache() {
  if (!fs.existsSync(PERSONA_DIR)) fs.mkdirSync(PERSONA_DIR);
  const files = fs.readdirSync(PERSONA_DIR);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const userPhone = path.basename(file, '.json');
      try {
        const persona = JSON.parse(fs.readFileSync(path.join(PERSONA_DIR, file), 'utf-8'));
        personasCache[userPhone] = persona;
        // Sincroniza usuários existentes com a tabela users do SQLite para o painel admin
        const nome = persona?.nome || null;
        try { upsertUser(userPhone, { name: nome }); } catch (_) {}
      } catch (e) {
        console.error(`Erro ao carregar persona ${file}: ${e.message}`);
      }
    }
  }
  console.log(`${Object.keys(personasCache).length} personas carregadas na memória.`);

  if (fs.existsSync(SPONSORED_FILE)) {
    try { sponsored = JSON.parse(fs.readFileSync(SPONSORED_FILE, 'utf-8')); } 
    catch (e) { console.error(`Erro ao carregar patrocinados: ${e.message}`); }
  }
}

// --- Helpers de patrocinados (load/save/merge) ---
function loadSponsored() {
  try {
    if (fs.existsSync(SPONSORED_FILE)) {
      const raw = fs.readFileSync(SPONSORED_FILE, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) sponsored = arr.filter(s => s && s.place_id);
    } else {
      sponsored = [];
    }
  } catch (e) {
    console.error('Erro ao carregar sponsored.json:', e.message);
  }
}

function saveSponsored() {
  try {
    fs.writeFileSync(SPONSORED_FILE, JSON.stringify(sponsored, null, 2));
    return true;
  } catch (e) {
    console.error('Erro ao salvar sponsored.json:', e.message);
    return false;
  }
}

// --- Parceiros por localização ---
async function getSponsoredNearby(lat, lng, maxKm = SPONSORED_NEAR_KM) {
  try {
    const actives = (sponsored || []).filter(s => s && s.active && s.place_id);
    const results = [];
    for (const s of actives) {
      try {
        const details = await getPlaceDetails(s.place_id);
        const loc = details?.geometry?.location;
        if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') continue;
        const km = haversineKm(lat, lng, loc.lat, loc.lng);
        if (km <= maxKm) results.push({ sponsor: s, details, km });
      } catch (_) { /* ignore details errors */ }
    }
    // Ordena por prioridade e distância
    results.sort((a, b) => {
      const pa = parseInt(a.sponsor?.prioridade, 10) || 99;
      const pb = parseInt(b.sponsor?.prioridade, 10) || 99;
      if (pa !== pb) return pa - pb;
      return a.km - b.km;
    });
    return results.slice(0, 3);
  } catch (_) { return []; }
}

async function sendNearbySponsored(recipientId, lat, lng) {
  try {
    const nearby = await getSponsoredNearby(lat, lng);
    if (!nearby || nearby.length === 0) return;
    const name = getUserName(recipientId) || 'parceiro';
    const intro = `Parceiros I.aê por perto de você, ${name}:`;
    await sendMessage(recipientId, intro);
    userState[recipientId].conversationHistory.push({ role: 'bot', message: intro });

    for (const item of nearby) {
      const s = item.sponsor;
      const details = item.details;
      const placeStub = { place_id: s.place_id, name: s.nome || details?.name || 'Parceiro', vicinity: details?.vicinity || details?.formatted_address || '' };
      let mapsLink = details?.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeStub.name)}&query_place_id=${placeStub.place_id}`;
      const destaqueLine = s?.destaque ? `\n📣 ${s.destaque}` : '';
      const msg = `*${placeStub.name}* — ${item.km.toFixed(1)} km\n📍 ${placeStub.vicinity}${destaqueLine}\n🔗 ${mapsLink}`;
      await sendMessage(recipientId, msg);
      userState[recipientId].conversationHistory.push({ role: 'bot', message: msg });

      const extra = composePartnerDetails(s, placeStub, details);
      if (extra) {
        await sendMessage(recipientId, extra);
        userState[recipientId].conversationHistory.push({ role: 'bot', message: extra });
      }
      try { metrics.recordPlaceShown({ place_id: placeStub.place_id, name: placeStub.name, vicinity: placeStub.vicinity }); } catch (_) {}
    }
  } catch (e) { try { console.error('[SPONSORED_NEARBY] erro:', e.message); } catch (_) {} }
}

function getSponsorsWithCounts() {
  const counts = metrics.getPlaceShownCounts ? metrics.getPlaceShownCounts() : {};
  return (sponsored || []).map(s => ({ ...s, shown: counts[s.place_id] || 0 }));
}

// --- Compor detalhes de parceiro (detalhes customizados) ---
function composePartnerDetails(sponsor, place, details) {
  try {
    if (!sponsor) return '';
    const parts = [];
    if (sponsor.detalhes || sponsor.descricao || sponsor.info) {
      const txt = sponsor.detalhes || sponsor.descricao || sponsor.info;
      parts.push(`\n🤝 Parceiro I.aê\n${txt}`);
    }
    if (sponsor.menu_link || sponsor.cardapio || sponsor.link_menu) {
      const link = sponsor.menu_link || sponsor.cardapio || sponsor.link_menu;
      parts.push(`\n📜 Cardápio: ${link}`);
    }
    if (sponsor.whatsapp) {
      parts.push(`\n📲 WhatsApp: ${sponsor.whatsapp}`);
    }
    if (sponsor.instagram) {
      parts.push(`\n📷 Instagram: ${sponsor.instagram}`);
    }
    if (sponsor.cta) {
      parts.push(`\n👉 ${sponsor.cta}`);
    }
    // Se houver detalhes do Google, adiciona site oficial se faltou
    const site = details?.website || details?.url;
    if (site && !String(parts.join('\n')).includes('Cardápio:')) {
      parts.push(`\n🔗 Perfil/Website: ${site}`);
    }
    return parts.length ? parts.join('') : '';
  } catch (_) {
    return '';
  }
}

// --- Normalização e detecção de menção de parceiro por texto ---
function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectSponsorMention(text) {
  try {
    const t = normalizeText(text);
    if (!t) return null;
    for (const s of (sponsored || [])) {
      if (!s?.active) continue;
      const name = normalizeText(s.nome || '');
      if (!name) continue;
      // Match simples: mensagem contém o nome, ou nome contém a mensagem curta
      if (t.includes(name) || (t.length >= 4 && name.includes(t))) {
        return s;
      }
      // Heurística: se nome tem duas palavras, aceita match por última palavra distinta
      const parts = name.split(' ').filter(Boolean);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        if (last.length >= 4 && t.includes(last)) return s;
      }
    }
    return null;
  } catch (_) { return null; }
}

// --- Indicador de digitação via Evolution API ---
async function sendTyping(to, delayMs = 800) {
  if (!EV_CAPS.presence) return;
  try {
    const instanceId = resolveInstanceIdFor(to);
    await axios.post(`${EV_URL_BASE}/chat/sendPresence/${instanceId}`, {
      number: to.replace('@s.whatsapp.net',''),
      options: { delay: delayMs, presence: 'composing' }
    }, { headers: { 'apikey': EVOLUTION_API_KEY } });
  } catch (_) {
    logErr('sendTyping', _);
    try {
      const status = _?.response?.status;
      if (status === 400 || status === 404) {
        EV_CAPS.presence = false;
        console.warn('[WARN] Evolution presence not supported. Disabling sendTyping.');
      }
    } catch (__) {}
  }
}

// --- Marcar mensagem como lida (read receipt) ---
async function markAsRead(to, messageId) {
  if (!EV_CAPS.readReceipt) return;
  if (!to || !messageId) return;
  const number = to.replace('@s.whatsapp.net','');
  const headers = { headers: { 'apikey': EVOLUTION_API_KEY } };
  // Tenta alguns endpoints comuns da Evolution; falhas são silenciosas
  try {
    const instanceId = resolveInstanceIdFor(to);
    await axios.post(`${EV_URL_BASE}/chat/readMessage/${instanceId}`, { number, messageId }, headers);
    return;
  } catch (e1) { logErr('markAsRead/readMessage', e1); }
  try {
    const instanceId = resolveInstanceIdFor(to);
    await axios.post(`${EV_URL_BASE}/chat/markAsRead/${instanceId}`, { number, messageId }, headers);
    return;
  } catch (e2) { logErr('markAsRead/markAsRead', e2); }
  try { EV_CAPS.readReceipt = false; console.warn('[WARN] Evolution read receipt not supported. Disabling markAsRead.'); } catch (_) {}
}

// --- Delay util ---
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// --- Simulação de digitando (delay dinâmico por tamanho da mensagem) ---
function calcTypingDelay(text) {
  const len = (text || '').length;
  // Base e fator por caractere
  const base = 500; // ms
  const perChar = 35; // ms por caractere
  let delay = base + perChar * Math.min(len, 120); // limita o impacto em mensagens muito longas
  // Clamps
  delay = Math.max(600, Math.min(delay, 3500));
  // Jitter para parecer menos robótico
  const jitter = Math.floor(Math.random() * 250) - 125; // -125..+125ms
  return Math.max(400, delay + jitter);
}

// --- Enviar mensagem ---
async function sendMessage(to, text) {
  if (!text || String(text).trim().length === 0) return;
  const out = String(text).trim();
  // Simula estado "digitando" via endpoint de presença + delay proporcional
  const delay = calcTypingDelay(out);
  await sendTyping(to, delay);
  await sleep(delay);
  const isTransient = (status, msg='') => {
    if (!status) return false;
    const s = Number(status);
    const m = String(msg || '').toLowerCase();
    return s === 429 || (s >= 500 && s < 600) || m.includes('bad gateway') || m.includes('timed out');
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const instanceId = resolveInstanceIdFor(to);
      await axios.post(`${EV_URL_BASE}/message/sendText/${instanceId}`, {
        number: to.replace('@s.whatsapp.net',''),
        text: out
      }, { headers: { 'apikey': EVOLUTION_API_KEY } });
      try { console.log('[EV] sendText ok to', to, 'len=', (out||'').length, 'attempt=', attempt); } catch (_) {}
      try { await saveMessage(to, 'bot', out); } catch (_) {}
      return;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const msg = err?.response?.data?.message || err.message;
      try { console.error('❌ sendText attempt=%d status=%s to=%s msg=%s', attempt, status || 'N/A', to, msg); } catch (_) {}
      if (isTransient(status, msg) && attempt < 3) {
        await sleep(400 * attempt); // backoff curto
        continue;
      }
      break;
    }
  }
  // Falhou após tentativas
  try {
    const status = lastErr?.response?.status;
    const body = lastErr?.response?.data;
    console.error("❌ Erro ao enviar mensagem para %s: %s | body=%j", to, lastErr?.response?.data?.message || lastErr?.message, body);
  } catch (_) {}
  // Evita fallback redundante quando o gateway está fora
  const status = lastErr?.response?.status;
  const msg = lastErr?.response?.data?.message || lastErr?.message || '';
  if (isTransient(status, msg)) return;
  try {
    const instanceId2 = resolveInstanceIdFor(to);
    await axios.post(`${EV_URL_BASE}/message/sendText/${instanceId2}`, {
      number: to.replace('@s.whatsapp.net',''),
      text: "Ops! Encontrei um probleminha para enviar sua mensagem. Tente novamente em alguns instantes, por favor! 🛠️"
    }, { headers: { 'apikey': EVOLUTION_API_KEY } });
    console.log('[DEBUG] Mensagem de fallback enviada com sucesso para %s', to);
    try { await saveMessage(to, 'bot', "Ops! Encontrei um probleminha para enviar sua mensagem. Tente novamente em alguns instantes, por favor! 🛠️"); } catch (_) {}
  } catch (sendError) {
    console.error('[DEBUG] Erro ao enviar mensagem de fallback para %s: %s', to, sendError.message);
  }
}

// --- Validação de mensagens (palavras inexistentes) ---
async function validateUserMessage(userMessage) {
  if (!userMessage || userMessage.trim().length === 0) return false;

  const prompt = `
Você é um assistente que verifica se uma mensagem do usuário contém palavras válidas ou faz sentido.
Mensagem do usuário: "${userMessage}".
Responda apenas com "valida" se a mensagem fizer sentido ou "invalida" se não fizer.
  `;
  try {
    const result = await model.generateContent(prompt);
    const text = (await result.response.text()).trim().toLowerCase();
    if (text.includes('valida')) return true;
  } catch (err) {
    console.error("Erro ao validar mensagem:", err.message);
  }
  return false;
}

// --- Entrevista inicial (bar vs restaurante) ---
const interviewQuestionsBar = [
  { key: 'nome', text: 'Olá! Eu sou a I.aê 🍻 Pra começar, qual é o seu nome?' },
  { key: 'tipo_bar', text: 'Que tipo de bar tu curte mais? (pub, boteco, balada, etc.)' },
  { key: 'ambiente', text: 'Qual vibe tu preferes? (agitado, tranquilo, sofisticado, música ao vivo)' },
  { key: 'bebida_preferida', text: 'Qual tua bebida preferida num bar? (chopp, vinho, drinks)' },
  { key: 'comida', text: 'E de rango, tu gostas de porções, sanduíches ou comida de boteco?' },
  { key: 'musica', text: 'Qual som ou entretenimento tu curtes? (rock, MPB, sertanejo, DJ, sem música)' },
  { key: 'preco', text: 'Qual tua faixa de preço? "econômico", "moderado" ou "luxuoso".' }
];

const interviewQuestionsRest = [
  { key: 'nome', text: 'Olá! Eu sou a I.aê 🍽️ Pra começar, qual é o seu nome?' },
  { key: 'cozinha', text: 'Qual cozinha você prefere hoje? (italiana, japonesa, brasileira, hamburgueria, veg/vegana, etc.)' },
  { key: 'ambiente', text: 'Prefere um ambiente mais sofisticado, familiar ou casual?' },
  { key: 'ocasião', text: 'Qual a ocasião? (almoço rápido, jantar romântico, com amigos, família)' },
  { key: 'restricoes', text: 'Tem alguma restrição ou preferência alimentar? (sem glúten, sem lactose, vegetariano)' },
  { key: 'bebida', text: 'Quer um lugar com boa carta de vinhos/drinks ou isso não é essencial?' },
  { key: 'preco', text: 'Qual tua faixa de preço? "econômico", "moderado" ou "luxuoso".' }
];

function getInterviewQuestions(type) {
  return (type === 'restaurante') ? interviewQuestionsRest : interviewQuestionsBar;
}

async function handleInterview(recipientId, userMessage, type = 'bar') {
  const questionsTop = getInterviewQuestions(type);
  if (!userState[recipientId] || !userState[recipientId].interview) {
    userState[recipientId] = { ...userState[recipientId], interview: { type, questionIndex: 0, answers: {} }, conversationHistory: userState[recipientId]?.conversationHistory || [] };
    const firstQ = questionsTop[0].text;
    await sendMessage(recipientId, firstQ);
    userState[recipientId].conversationHistory.push({ role: 'bot', message: firstQ });
    userState[recipientId].interview.questionIndex = 1;
    userState[recipientId].interview.lastAskedIndex = 1;
    return;
  }

  const state = userState[recipientId].interview;
  const questionsLocal = getInterviewQuestions(state.type);
  const prevIndex = state.questionIndex - 1;
  if (prevIndex >= 0 && prevIndex < questionsLocal.length) {
    state.answers[questionsLocal[prevIndex].key] = userMessage;
    userState[recipientId].conversationHistory.push({ role: 'user', message: userMessage });
  }

  if (state.questionIndex >= questionsLocal.length) {
    const personaPath = path.join(PERSONA_DIR, `${recipientId}.json`);
    try {
      const domainKey = (state.type === 'restaurante') ? 'rest' : 'bar';
      const existing = personasCache[recipientId] || {};
      const updated = { ...existing };
      // move nome para raiz para uso geral, mas mantém também no domínio
      const nameFromAnswers = state.answers?.nome;
      if (nameFromAnswers) updated.nome = updated.nome || nameFromAnswers;
      updated[domainKey] = { ...(existing[domainKey] || {}), ...state.answers };
      personasCache[recipientId] = updated;
      fs.writeFileSync(personaPath, JSON.stringify(updated, null, 2));
      // Persist preferences in DB (C)
      try { await upsertManyPrefs(recipientId, sanitizeForPersona(state.answers)); } catch (_) {}
    } catch (e) { console.error(`Erro ao salvar persona para ${recipientId}: ${e.message}`); }
    
    // Após finalizar a entrevista, encaminha direto para escolha de localização
    delete userState[recipientId].interview;
    const name = getUserName(recipientId) || state.answers?.nome || 'parceiro';
    // Guarda o contexto para localização
    userState[recipientId].awaiting_location_type = { type: state.type, answers: state.answers };
    const ask = `Boa, ${name}! Você prefere que eu procure *perto de você* (me envie sua localização) ou em *outro lugar* (digite bairro/cidade/ponto)?`;
    await sendMessage(recipientId, ask);
    userState[recipientId].conversationHistory.push({ role: 'bot', message: ask });
    return;
  }

  const currentQuestion = questionsLocal[state.questionIndex];
  // Dedupe: não reenviar a mesma pergunta se já perguntada
  if (state.lastAskedIndex === state.questionIndex) {
    return;
  }
  const name = getUserName(recipientId) || '';
  const prevKey = questionsLocal[prevIndex]?.key;
  const lastAnswer = state.answers[prevKey];
  const lead = prevIndex === 0
    ? (name ? `Prazer, ${name}! ` : '')
    : bridgeFromInterview(prevKey, lastAnswer, name || '') + ' ';
  const composed = lead + currentQuestion.text;
  await sendMessage(recipientId, composed);
  userState[recipientId].conversationHistory.push({ role: 'bot', message: composed });
  state.lastAskedIndex = state.questionIndex;
  state.questionIndex++;
}

// --- Escolha de intenção quando não clara ---
async function handleIntentChoice(recipientId, userMessage) {
  // Entrevista inicial foi desativada: esta função é mantida apenas por compatibilidade
  // e não deve mais disparar o fluxo de entrevista.
  return false;
}

// --- NLU inicial com Gemini ---
async function parseInitialIntent(userMessage, persona) {
  const personaInfo = JSON.stringify(persona || {});
  const prompt = `Você é um assistente que extrai a intenção e preferências de um usuário para recomendar bares ou restaurantes. Perfil do usuário (se existir): ${personaInfo}. Mensagem do usuário: "${userMessage}". Sua tarefa é identificar a intenção principal (bar, restaurante, ou nenhum) e extrair quaisquer preferências mencionadas na mensagem. Responda com um objeto JSON com os campos: intention e preferences.`;
  try {
    const TIMEOUT_MS = parseInt(process.env.INIT_INTENT_TIMEOUT_MS || '1200');
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))
    ]);
    if (!result) {
      const intentFallback = detectChosenIntent(userMessage) || 'nenhum';
      const prefsFallback = derivePrefsFromMessage(userMessage) || {};
      return { intention: intentFallback, preferences: prefsFallback };
    }
    const textResult = (await result.response.text()).trim();
    // Tenta extrair o primeiro bloco JSON de maneira robusta
    const fenced = textResult.replace(/```json\n|```/g, '').trim();
    let candidate = fenced;
    const match = candidate.match(/\{[\s\S]*\}/);
    if (match) candidate = match[0];
    try {
      return JSON.parse(candidate);
    } catch (e) {
      const intentFallback = detectChosenIntent(userMessage) || 'nenhum';
      const prefsFallback = derivePrefsFromMessage(userMessage) || {};
      return { intention: intentFallback, preferences: prefsFallback };
    }
  } catch (err) {
    console.error("Erro ao analisar intenção inicial com Gemini:", err);
    const intentFallback = detectChosenIntent(userMessage) || 'nenhum';
    const prefsFallback = derivePrefsFromMessage(userMessage) || {};
    return { intention: intentFallback, preferences: prefsFallback };
  }
}

// --- Contexto situacional ---
function checkSituationalContext(userMessage) {
  const lower = userMessage.toLowerCase();
  if (lower.includes('bar') || lower.includes('boteco') || lower.includes('rolê') || lower.includes('barzinho')) {
    return { context: 'bar', moodQuestions: ['Boa! 🍻 Tá pensando num lugar mais agitado ou tranquilo hoje?', 'Vai acompanhado ou é solo esse rolê?', 'Quer com música ao vivo ou algo mais sossegado?'] };
  }
  if (lower.includes('restaurante') || lower.includes('jantar') || lower.includes('almoço') || lower.includes('restô')) {
    return { context: 'restaurante', moodQuestions: ['Show! 🍽️ Quer algo mais sofisticado ou casual?', 'Vai sozinho, com amigos ou é um encontro especial?', 'Procura mais algo pra comer bem ou algo rápido e prático?'] };
  }
  return null;
}

// --- Detect intent from short reply (bar/restaurante)
function detectChosenIntent(msg) {
  const lower = String(msg || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const tokens = lower.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  const set = new Set(tokens);
  const saysBar = set.has('bar') || set.has('bares') || set.has('pub') || set.has('boteco') || set.has('barzinho') || lower.includes('barzin');
  const saysRest = set.has('restaurante') || set.has('restaurantes') || set.has('jantar') || set.has('almoco') || set.has('almoc') || set.has('resto') || set.has('restaurantez') || lower.includes('restaur');
  if (saysBar && !saysRest) { try { console.log('[INTENT] escolhido=bar via tokens'); } catch (_) {} return 'bar'; }
  if (saysRest && !saysBar) { try { console.log('[INTENT] escolhido=restaurante via tokens'); } catch (_) {} return 'restaurante'; }
  if (saysBar && saysRest) {
    // Se ambos aparecem, escolhe o que foi mencionado por último no texto
    const lastBarIdx = Math.max(lower.lastIndexOf(' bar '), lower.lastIndexOf(' bar'), lower.lastIndexOf('bar '), lower.lastIndexOf('barzinho'));
    const lastRestIdx = Math.max(lower.lastIndexOf(' restaurante '), lower.lastIndexOf(' restaurante'), lower.lastIndexOf('restaurante '), lower.lastIndexOf('restaur'));
    if (lastBarIdx > lastRestIdx) { try { console.log('[INTENT] ambos citados, preferindo bar (mais recente)'); } catch (_) {} return 'bar'; }
    if (lastRestIdx > lastBarIdx) { try { console.log('[INTENT] ambos citados, preferindo restaurante (mais recente)'); } catch (_) {} return 'restaurante'; }
  }
  return null;
}

// --- O resto do código segue normalmente


// --- Prompt humanizado para o refinamento ---
async function startDynamicRefinement(recipientId, initialUserMessage, type, initialPreferences = {}) {
  if (!userState[recipientId]) userState[recipientId] = { conversationHistory: [] };
  userState[recipientId].conversationHistory.push({ role: 'user', message: initialUserMessage });
  const persona = personasCache[recipientId] || {};
  const domainKey = (type === 'restaurante') ? 'rest' : 'bar';
  const domainPersona = persona[domainKey] || {};
  const sharedName = persona.nome || domainPersona.nome;
  const filters = extractSearchFilters(initialUserMessage);
  // Merge saved user_preferences to bias search
  let savedPrefs = {};
  try { savedPrefs = await getUserPrefs(recipientId) || {}; } catch (_) {}
  const prefKeywords = [];
  if (savedPrefs.prefers_chopp === 'true') prefKeywords.push('chopp');
  if (savedPrefs.prefers_cerveja === 'true') prefKeywords.push('cerveja');
  if (savedPrefs.prefers_happy_hour === 'true') prefKeywords.push('happy hour');
  if (savedPrefs.prefers_musica_ao_vivo === 'true' || savedPrefs.prefers_musica === 'true') prefKeywords.push('música ao vivo');
  if (savedPrefs.prefers_bar_estilo === 'true') prefKeywords.push('bar');
  if (savedPrefs.prefers_rodizio === 'true') prefKeywords.push('rodízio');
  if (savedPrefs.last_freeform_keyword) prefKeywords.push(savedPrefs.last_freeform_keyword);
  const mergedFilters = { ...filters };
  if (prefKeywords.length > 0) {
    if (!mergedFilters.filters) mergedFilters.filters = {};
    mergedFilters.filters.keyword = [mergedFilters.filters?.keyword, ...prefKeywords].filter(Boolean).join(' ');
  }
  const currentAnswers = { ...(sharedName ? { nome: sharedName } : {}), ...domainPersona, ...initialPreferences, ...mergedFilters };

  // Antes de pedir localização, perguntamos se quer "perto de mim" ou "outro lugar"
  userState[recipientId].awaiting_location_type = { type, answers: currentAnswers };
  const name = getUserName(recipientId) || 'parceiro';
  const ask = `Boa, ${name}! Você prefere que eu procure *perto de você* (me envie sua localização) ou em *outro lugar* (digite bairro/cidade/ponto)?`;
  await sendMessage(recipientId, ask);
  userState[recipientId].conversationHistory.push({ role: 'bot', message: ask });
}

// --- Handle when user answers the location-type question ---
async function handleLocationTypeResponse(recipientId, userMessage) {
  const state = userState[recipientId];
  if (!state?.awaiting_location_type) return false;

  const lower = (userMessage || '').toLowerCase();
  const { type, answers } = state.awaiting_location_type;

  // If user sends a location message instead of text, the webhook location path will handle it before this function.

  // Detecta respostas "perto" ou "aqui"
  if (lower.includes('perto') || lower.includes('aqui') || lower.includes('próximo') || lower.includes('proximo') || lower.includes('perto de mim')) {
    // Espera a localização via WhatsApp
    state.refinement = { type, answers, lat: null, lng: null };
    state.awaitingLocation = true; // flag para indicar que esperamos coords
    delete state.awaiting_location_type;
    const name = getUserName(recipientId) || 'parceiro';
    const askLoc = `Beleza, ${name}! Manda sua localização no WhatsApp (use o botão de compartilhar localização) que eu procuro os lugares por perto 📍`;
    await sendMessage(recipientId, askLoc);
    state.conversationHistory.push({ role: 'bot', message: askLoc });
    return true;
  }

  // Detecta respostas "outro", ou assume que a mensagem é um texto de lugar
  if (lower.includes('outro') || lower.includes('lugar') || lower.includes('bairro') || lower.includes('cidade')) {
    state.awaiting_location_text = { type, answers };
    delete state.awaiting_location_type;
    const name = getUserName(recipientId) || 'parceiro';
    const askText = `Show, ${name}! Me diz o nome do bairro, cidade ou ponto de referência que você quer que eu pesquise (ex: Águas Claras Brasília).`;
    // Se a mensagem já contém algum possível local (ex.: "Outro lugar, asa norte DF"), tenta usar imediatamente;
    // caso contrário, pergunta explicitamente o texto do lugar.
    const hint = (userMessage || '').toLowerCase();
    const hasDirectPlace = hint.replace(/outro|lugar|quero|na|no|em|bairro|cidade|de|da|do/gi, '').trim().length > 0;
    if (hasDirectPlace) {
      // Usa a própria mensagem como entrada de lugar
      await handleTextPlaceSearch(recipientId, userMessage);
      return true;
    } else {
      await sendMessage(recipientId, askText);
      state.conversationHistory.push({ role: 'bot', message: askText });
      return true;
    }
  }

  // Se a mensagem não for óbvia, entendemos que o usuário pode ter enviado o nome do lugar diretamente
  // Então tratamos como texto de busca
  state.awaiting_location_text = { type, answers };
  delete state.awaiting_location_type;
  // Reutiliza a mesma mensagem como se o usuário tivesse enviado o lugar
  await handleTextPlaceSearch(recipientId, userMessage);
  return true;
}

// --- Refinamento dinâmico das perguntas rápidas (moodQuestions) ---
async function handleDynamicRefinement(recipientId, userMessage) {
  const state = userState[recipientId];
  if (!state?.refinement || !Array.isArray(state.refinement.questions)) return false;

  const { questions, type } = state.refinement;
  const step = typeof state.refinement.step === 'number' ? state.refinement.step : 0;

  // Guarda a resposta do usuário para a pergunta atual
  state.refinement.answers = state.refinement.answers || {};
  state.refinement.answers[`q${step + 1}`] = userMessage;
  state.conversationHistory.push({ role: 'user', message: userMessage });

  const nextStep = step + 1;
  // Se ainda há perguntas, envia a próxima
  if (nextStep < questions.length) {
    state.refinement.step = nextStep;
    const nextQ = questions[nextStep];
    const name = getUserName(recipientId) || 'parceiro';
    const lead = userMessage ? `Show, ${name}! Anotei: "${shortText(userMessage)}". ` : `Beleza, ${name}! `;
    const composed = lead + nextQ;
    // Dedupe: não reenvia mesma pergunta
    if (state.refinement.lastAskedStep !== nextStep) {
      await sendMessage(recipientId, composed);
      state.conversationHistory.push({ role: 'bot', message: composed });
      state.refinement.lastAskedStep = nextStep;
    }
    return true;
  }

  // Terminou as perguntas: encaminha para escolha de localização (perto x outro lugar)
  const persona = personasCache[recipientId] || {};
  const combinedAnswers = { ...persona, ...(state.refinement.answers || {}) };

  // Limpa o bloco de refinamento atual e solicita tipo de localização (perguntar apenas uma vez)
  delete state.refinement;
  if (!state.awaiting_location_type) {
    state.awaiting_location_type = { type, answers: combinedAnswers };
    state.awaiting_location_type_asked = true;
    const name = getUserName(recipientId) || 'parceiro';
    const ask = `Boa, ${name}! Você prefere que eu procure *perto de você* (me envie sua localização) ou em *outro lugar* (digite bairro/cidade/ponto)?`;
    await sendMessage(recipientId, ask);
    state.conversationHistory.push({ role: 'bot', message: ask });
  }
  return true;
}

// --- Geocodifica/busca por texto (Places Text Search) ---
async function geocodeTextPlace(query) {
  try {
    console.log('[GEO] Iniciando geocodificação para query:', query);
    // Sanitiza a consulta removendo palavras de controle comuns
    const cleaned = String(query || '')
      .replace(/\boutro\b|\blugar\b|\bquero\b|\bperto\b|\bna\b|\bno\b|\bem\b|\bbairro\b|\bcidade\b|\bde\b|\bda\b|\bdo\b/gi, ' ')
      .replace(/[.,;:!?#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    console.log('[GEO] Query após limpeza:', cleaned);
    
    // Adiciona "Brasília" se não estiver na query
    let q = cleaned || String(query || '').trim();
    if (!q.toLowerCase().includes('brasília') && !q.toLowerCase().includes('brasilia')) {
      console.log('[GEO] Adicionando "Brasília" à query');
      q += ' Brasília';
    }
    
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${GOOGLE_MAPS_API_KEY}`;
    console.log('[GEO] URL da requisição:', url);
    console.log('[GEO] textsearch query="%s" cleaned="%s"', query, q);
    
    const resp = await axios.get(url, { timeout: 15000 }); // Aumentei o timeout para 15 segundos
    console.log('[GEO] Resposta da API:', JSON.stringify(resp.data, null, 2));
    
    if (resp.data && resp.data.results && resp.data.results.length > 0) {
      const best = resp.data.results[0];
      console.log('[GEO] Melhor resultado encontrado:', best.name, 'em', best.formatted_address);
      console.log('[GEO] Coordenadas:', best.geometry.location.lat + ',' + best.geometry.location.lng);
      return { 
        lat: best.geometry.location.lat, 
        lng: best.geometry.location.lng, 
        name: best.formatted_address || best.name 
      };
    } else {
      console.log('[GEO] Nenhum resultado encontrado para a query:', q);
      console.log('[GEO] Status da resposta:', resp.data.status);
      if (resp.data.error_message) {
        console.error('[GEO] Mensagem de erro da API:', resp.data.error_message);
      }
    }
  } catch (err) {
    console.error('Erro no geocodeTextPlace:', err.message);
  }
  return null;
}

async function handleTextPlaceSearch(recipientId, userMessage) {
  console.log('[DEBUG] handleTextPlaceSearch chamado para mensagem:', userMessage);
  const state = userState[recipientId];
  if (!state?.awaiting_location_text) {
    console.log('[DEBUG] Ignorando mensagem - não está aguardando localização');
    return false;
  }
  
  const { type, answers } = state.awaiting_location_text;
  console.log(`[DEBUG] Tipo de busca: ${type}, respostas:`, answers);

  const name = getUserName(recipientId) || 'parceiro';
  const searching = `Massa, ${name}! Procurando por "${userMessage}"... 🔎`;
  console.log('[DEBUG] Enviando mensagem de busca:', searching);
  await sendMessage(recipientId, searching);
  state.conversationHistory.push({ role: 'bot', message: searching });

  console.log('[DEBUG] Chamando geocodeTextPlace para:', userMessage);
  const geo = await geocodeTextPlace(userMessage);
  
  if (!geo) {
    const fail = `Não consegui localizar esse lugar direito, ${name} 😕. Pode tentar escrever de outro jeito (ex: "Águas Claras Brasília")?`;
    console.log('[DEBUG] Falha ao geocodificar:', fail);
    await sendMessage(recipientId, fail);
    state.conversationHistory.push({ role: 'bot', message: fail });
    return true;
  }

  console.log('[DEBUG] Localização encontrada:', geo);
  
  // Monta o refinement e busca nos arredores do ponto geocodificado
  const enrichedAnswers = { ...answers, keyword: userMessage };
  state.refinement = { 
    type, 
    answers: enrichedAnswers, 
    lat: geo.lat, 
    lng: geo.lng, 
    fromText: true 
  };
  
  delete state.awaiting_location_text;
  console.log('[DEBUG] Chamando finalizeSearch para:', recipientId);
  await finalizeSearch(recipientId);
  return true;
}

// --- Buscar lugares com Google Places ---
async function getNearbyPlaces(lat, lng, types, options = {}) {
  const radius = 5000; // 5 km
  let allResults = [];
  console.log(`[PLACES] Buscando lugares próximos a (${lat}, ${lng})`);
  console.log(`[PLACES] Tipos: ${types.join(', ')}`);
  console.log(`[PLACES] Opções:`, options);
  
  try {
    for (const type of types) {
      console.log(`[PLACES] Buscando tipo: ${type}`);
      const params = new URLSearchParams({
        location: `${lat},${lng}`,
        radius: String(radius),
        type,
        key: GOOGLE_MAPS_API_KEY,
      });
      
      if (options.keyword) {
        params.append('keyword', options.keyword);
        console.log(`[PLACES] Com palavra-chave: ${options.keyword}`);
      }
      
      if (options.openNow) {
        params.append('opennow', 'true');
        console.log('[PLACES] Apenas lugares abertos agora');
      }
      
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`;
      console.log(`[PLACES] URL da requisição: ${url.replace(GOOGLE_MAPS_API_KEY, '***')}`);
      
      try {
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`[PLACES] Resposta para ${type}: ${response.data?.results?.length || 0} resultados`);
        
        if (response.data?.results?.length > 0) {
          allResults = allResults.concat(response.data.results);
          console.log(`[PLACES] Primeiro resultado: ${response.data.results[0]?.name} (${response.data.results[0]?.types?.join(', ')})`);
        } else {
          console.log(`[PLACES] Nenhum resultado para o tipo ${type}`);
          if (response.data?.error_message) {
            console.error(`[PLACES] Erro na API: ${response.data.error_message}`);
          }
        }
      } catch (apiErr) {
        console.error(`[PLACES] Erro na requisição para o tipo ${type}:`, apiErr.message);
        if (apiErr.response) {
          console.error(`[PLACES] Resposta do erro:`, apiErr.response.data);
        }
      }
    }
    
    const uniqueResults = Array.from(new Map(allResults.map(p => [p.place_id, p])).values());
    console.log(`[PLACES] Total de resultados únicos encontrados: ${uniqueResults.length}`);
    return uniqueResults;
    
  } catch (err) {
    console.error("[PLACES] Erro ao buscar lugares próximos no Google Places:", err.message);
    if (err.response) {
      console.error("[PLACES] Detalhes do erro:", err.response.data);
    }
    return [];
  }
}

async function getNearbyBars(lat, lng, options) {
  const raw = await getNearbyPlaces(lat, lng, ['bar', 'pub', 'night_club'], options);
  return filterPlacesByType(raw, 'bar');
}
async function getNearbyRestaurants(lat, lng, options) {
  const raw = await getNearbyPlaces(lat, lng, ['restaurant', 'cafe'], options);
  return filterPlacesByType(raw, 'restaurante');
}

// --- Detalhes do lugar (Phone, site, etc.) ---
async function getPlaceDetails(placeId, userIntent = '') {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/details/json`,
      {
        params: {
          place_id: placeId,
          fields: 'name,formatted_phone_number,website,opening_hours,price_level,rating,user_ratings_total,types,reviews',
          key: GOOGLE_MAPS_API_KEY,
          language: 'pt-BR',
          reviews_sort: 'most_relevant',
          max_reviews: 5
        }
      }
    );
    
    const place = response.data.result || null;
    
    if (place) {
      // Enhance place data with inferred features from reviews
      if (userIntent) {
        const reviewFeatures = await recommendationEngine.analyzeGoogleReviews(placeId, userIntent);
        place.inferredFeatures = reviewFeatures;
      }
    }
    
    return place;
  } catch (error) {
    console.error('Error fetching place details:', error.message);
    return null;
  }
}

// --- Resolver lugar por nome/texto (Find Place)
async function resolvePlaceByName(text, locationBias = null) {
  try {
    const raw = String(text || '');
    const cleaned = raw
      .toLowerCase()
      .replace(/(onde fica|aonde fica|qual o endereço|endereco|endereço|como chegar|perto do|perto da|perto de)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;

    const params = new URLSearchParams({
      input: cleaned,
      inputtype: 'textquery',
      fields: 'place_id,name,formatted_address',
      language: 'pt-BR',
      region: 'BR',
      key: GOOGLE_MAPS_API_KEY,
    });
    if (locationBias && typeof locationBias.lat === 'number' && typeof locationBias.lng === 'number') {
      params.set('locationbias', `circle:50000@${locationBias.lat},${locationBias.lng}`);
    }
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params.toString()}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    if (data && data.status === 'OK' && Array.isArray(data.candidates) && data.candidates.length > 0) {
      return data.candidates[0];
    }
    return null;
  } catch (err) {
    console.error('Erro ao resolver lugar por nome:', err.message);
    return null;
  }
}

// --- Rank semântico com Gemini ---
async function rankGeneric(places, persona, currentPreferences) {
  console.log(`[RANK] Iniciando ranking semântico para ${places.length} lugares`);
  console.log(`[RANK] Persona: ${JSON.stringify(persona)}`);
  console.log(`[RANK] Preferências atuais: ${JSON.stringify(currentPreferences)}`);
  
  // Se não houver lugares, retorna array vazio
  if (!places || places.length === 0) return [];
  
  // Se o Gemini não estiver disponível, retorna os lugares ordenados por classificação
  if (!model) {
    console.log('[RANK] Gemini não disponível, usando classificação básica');
    return sortPlacesByBasicScore(places);
  }

  const timeoutMs = 2500; // limite por item
  const batchSize = 4;    // concorrência limitada

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), ms))
    ]);
  }

  // Função auxiliar para ordenação básica baseada em rating e número de avaliações
  function sortPlacesByBasicScore(placesToSort) {
    return [...placesToSort].sort((a, b) => {
      const scoreA = calculateBasicScore(a);
      const scoreB = calculateBasicScore(b);
      return scoreB - scoreA;
    });
  }

  // Função auxiliar para calcular pontuação básica
  function calculateBasicScore(place) {
    return (place.rating || 0) * 2 + Math.log10(place.user_ratings_total || 1);
  }

  async function scorePlace(place) {
    try {
      // Pontuação base: rating e número de avaliações
      let score = calculateBasicScore(place);
      
      // Ajuste baseado nas preferências de preço da persona
      if (persona?.preco) {
        const preco = (persona.preco || '').toLowerCase();
        if (preco.includes('econ')) score += (place.price_level <= 1 ? 2 : 0);
        if (preco.includes('moder')) score += (place.price_level === 2 || place.price_level === 3 ? 2 : 0);
        if (preco.includes('luxo')) score += (place.price_level === 4 ? 2 : 0);
      }
      
      // Bônus para lugares patrocinados ativos
      const isSponsored = sponsored.some(s => s.place_id === place.place_id && s.active);
      if (isSponsored) score += 3;
      
      // Tenta usar o Gemini para ajuste fino, mas não trava se falhar
      try {
        const prompt = `Avalie a relevância deste ${place.types?.includes('bar') ? 'bar' : 'restaurante'} "${place.name}" ` +
                      `para um usuário que gosta de ${JSON.stringify(persona || {})}. ` +
                      `Retorne APENAS um número entre 0 e 5, onde 0 é irrelevante e 5 é altamente relevante.`;
        
        const response = await withTimeout(
          model.generateContent(prompt),
          timeoutMs
        );
        
        if (response) {
          const text = await response.response.text();
          const geminiScore = parseFloat(text.trim());
          if (!isNaN(geminiScore) && geminiScore >= 0 && geminiScore <= 5) {
            score += geminiScore * 0.5; // Peso menor para o Gemini
          }
        }
      } catch (geminiError) {
        console.error('[RANK] Erro ao consultar Gemini para ranking:', geminiError.message);
        // Continua com a pontuação base se o Gemini falhar
      }
      
      return { ...place, _score: score };
      
    } catch (error) {
      console.error(`[RANK] Erro ao pontuar lugar ${place.place_id}:`, error.message);
      // Retorna uma pontuação básica em caso de erro
      return { ...place, _score: calculateBasicScore(place) };
    }
  }
  
  try {
    // Processa em lotes para evitar sobrecarga
    const processedPlaces = [];
    for (let i = 0; i < places.length; i += batchSize) {
      const batch = places.slice(i, i + batchSize);
      const scoredBatch = await Promise.all(batch.map(place => withTimeout(scorePlace(place), timeoutMs)));
      processedPlaces.push(...scoredBatch.filter(Boolean));
    }
    
    // Ordena por pontuação decrescente
    return processedPlaces.sort((a, b) => (b._score || 0) - (a._score || 0));
    
  } catch (error) {
    console.error('[RANK] Erro no processamento em lote, retornando ordenação básica:', error.message);
    return sortPlacesByBasicScore(places);
  }
}

// --- Apresentar recomendações (com paginação simples) ---
async function presentRecommendations(recipientId, places, startIndex = 0) {
  const state = userState[recipientId];
  if (!state || !places || places.length === 0) {
    await sendMessage(recipientId, 'Não encontrei lugares que combinem com o que você procura. Tente ajustar os filtros!');
    return;
  }

  const persona = personasCache[recipientId] || {};
  const name = getUserName(recipientId) || persona.nome || 'parceiro';
  const slice = places.slice(startIndex, startIndex + 3);

  // Mensagem introdutória fixa para evitar recomendações inventadas
  const label = persona.rest ? 'restaurantes' : 'lugares';
  const intro = `Beleza, ${name}! Achei alguns ${label} que têm tudo a ver com o que você pediu. Dá uma olhada nesses aqui:`;
  await sendMessage(recipientId, intro);
  userState[recipientId].conversationHistory.push({ role: 'bot', message: intro });

  // Envia cada lugar individualmente
  for (let i = 0; i < slice.length; i++) {
    const p = slice[i];
    const number = i + 1; // 1..3 na página atual
    // Prefere link de perfil oficial do Google (details.url) com timeout curto; caso não disponível, usa busca por place_id
    let mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${p.place_id}`;
    try {
      const details = await Promise.race([
        getPlaceDetails(p.place_id),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000))
      ]);
      if (details?.url) {
        mapsLink = details.url;
      } else {
        try { console.log('[REC] perfil oficial indisponível, usando query_place_id', { name: p.name, place_id: p.place_id }); } catch (_) {}
      }
    } catch (err) {
      try { console.log('[REC] erro ao obter perfil oficial, usando query_place_id', { name: p.name, place_id: p.place_id, err: err?.message }); } catch (_) {}
    }
    try { console.log('[REC] preparando recomendação', { to: recipientId, idx: number, name: p.name, place_id: p.place_id, mapsLink }); } catch (_) {}
    const sponsor = sponsored.find(s => s.place_id === p.place_id && s.active);
    const destaqueLine = sponsor?.destaque ? `\n📣 ${sponsor.destaque}` : '';
    const msg = `*${number}. ${p.name}*\n⭐ ${p.rating || 'N/A'} (${p.user_ratings_total || 0} avaliações)\n📍 ${p.vicinity}${destaqueLine}\n🔗 ${mapsLink}`;
    await sendMessage(recipientId, msg);
    try { console.log('[REC] recomendação enviada', { to: recipientId, idx: number, name: p.name }); } catch (_) {}
    userState[recipientId].conversationHistory.push({ role: 'bot', message: msg });
    try { metrics.recordPlaceShown({ place_id: p.place_id, name: p.name, vicinity: p.vicinity }); } catch (_) {}

    // Envia detalhes extras de parceiro, se houver
    try {
      const partnerExtra = composePartnerDetails(sponsor, p, null);
      if (partnerExtra) {
        await sendMessage(recipientId, partnerExtra);
        userState[recipientId].conversationHistory.push({ role: 'bot', message: partnerExtra });
      }
    } catch (_) {}
  }

  // CTA ao final dos itens (Gemini)
  const ctaHint = 'Convide o usuário de forma breve e simpática para ver mais, filtrar (ex.: preço/música ao vivo) ou escolher 1, 2 ou 3.';
  const cta = await sendAdaptive(recipientId, ctaHint);
  userState[recipientId].conversationHistory.push({ role: 'bot', message: cta });

  // Guarda estado de paginação
  userState[recipientId].cta = { ordered: places, index: startIndex };
}

// --- Handle user feedback about place features ---
async function handleFeatureFeedback(recipientId, placeId, feature, isAccurate) {
  try {
    await recommendationEngine.saveUserFeedback({
      userId: recipientId,
      placeId,
      feature,
      isAccurate,
      timestamp: Date.now()
    });
    
    // Update the user's confidence in this feature
    const confidence = await recommendationEngine.getFeatureConfidence(placeId, feature);
    
    // You could add logic here to adjust recommendations based on feedback
    console.log(`[FEEDBACK] User ${recipientId} provided feedback on ${feature} for place ${placeId}: ${isAccurate ? 'accurate' : 'inaccurate'} (confidence: ${confidence.toFixed(2)})`);
    
    return true;
  } catch (error) {
    console.error('Error handling feature feedback:', error.message);
    return false;
  }
}

// --- Finalizar busca ---
async function finalizeSearch(recipientId) {
  const state = userState[recipientId];
  
  // Proteção contra execução duplicada
  if (state?.isFinalizing) {
    try { console.log('[IDEMP] Ignorando finalizeSearch duplicado para', recipientId); } catch (_) {}
    return;
  }
  
  // Marca que está finalizando para evitar duplicação
  state.isFinalizing = true;
  
  try {
    if (!state?.refinement || !state.refinement.lat || !state.refinement.lng) {
      const name = getUserName(recipientId) || 'parceiro';
      const botMessage = `Ops! Não consegui finalizar a busca, ${name}. Parece que perdi o contexto ou sua localização. Poderia começar novamente?`;
      await sendMessage(recipientId, botMessage);
      state?.conversationHistory?.push({ role: 'bot', message: botMessage });
      delete state.refinement;
      delete state.awaitingLocation;
      return;
    }

  const { type, answers, lat, lng } = state.refinement;
  const persona = personasCache[recipientId] || {};
  const domainKey = (type === 'restaurante') ? 'rest' : 'bar';
  const domainPersona = persona[domainKey] || {};

  const nm = getUserName(recipientId) || persona.nome || '';
  const processingMessage = `${nm ? `Beleza, ${nm}! ` : 'Beleza! '}Deixa eu dar uma olhada nos lugares próximos que são a sua cara 🍻`;
  await sendMessage(recipientId, processingMessage);
  state.conversationHistory.push({ role: 'bot', message: processingMessage });

  // Important: clear awaiting flags early to avoid duplicate "Agradeço" messages
  delete state.awaitingLocation;
  delete state.awaiting_location_type;
  delete state.awaiting_location_text;

  // Persiste um snapshot da última busca para reutilizar em refinamentos rápidos (ex.: futebol)
  try {
    state.lastSearch = {
      type,
      lat,
      lng,
      answers: { ...(answers || {}) }
    };
  } catch (_) {}

  let places = [];
  const options = { keyword: answers.keyword || answers.filters?.keyword, openNow: !!(answers.openNow || answers.filters?.openNow) };
  
  console.log(`[DEBUG] Buscando lugares do tipo ${type} com opções:`, options);
  
  if (type === 'bar') { 
    console.log('[DEBUG] Chamando getNearbyBars');
    places = await getNearbyBars(lat, lng, options);
  } else { 
    console.log('[DEBUG] Chamando getNearbyRestaurants');
    places = await getNearbyRestaurants(lat, lng, options);
  }
  
  console.log(`[DEBUG] ${places?.length || 0} lugares encontrados antes do filtro`);
  
  // Filtro de segurança extra
  const domain = type === 'bar' ? 'bar' : 'restaurante';
  console.log(`[DEBUG] Aplicando filtro para domínio: ${domain}`);
  places = filterPlacesByType(places, domain);
  console.log(`[DEBUG] ${places?.length || 0} lugares restantes após filtro`);
  // Garante proximidade do centro enviado
  const before = places.length;
  places = filterByDistance(places, lat, lng, 15);
  if (process.env.NODE_ENV !== 'production') {
    const first = places[0];
    console.log('[LOC] coords recebidas:', lat, lng, '| resultados:', before, '->', places.length, '| primeiro:', first?.name, '-', first?.vicinity);
  }

  // Pré-filtro heurístico para reduzir custo/latência do ranking semântico
  const boosted = places.map(p => {
    const base = (p.rating || 0) * 2 + Math.log10(p.user_ratings_total || 1);
    const isSponsored = sponsored.find(b => b.place_id === p.place_id && b.active);
    const sponsorBoost = isSponsored ? 3 : 0;
    return { ...p, _pref: base + sponsorBoost };
  }).sort((a, b) => (b._pref - a._pref)).slice(0, 12);

  // Ranking semântico apenas nos melhores
  places = await rankGeneric(boosted, domainPersona, answers);

  // Promoção de patrocinados (1º, 2º, 3º) por prioridade quando presentes
  places = promoteSponsoredOrder(places);

  if (!places || places.length === 0) {
    const name = getUserName(recipientId) || 'parceiro';
    const noResultsMessage = `Não achei nada que bata certinho com o que você pediu, ${name} 😢. Que tal tentar com outras preferências?`;
    await sendMessage(recipientId, noResultsMessage);
    state.conversationHistory.push({ role: 'bot', message: noResultsMessage });
    delete state.refinement;
    return;
  }

  // Salva a última escolha
  if (!personasCache[recipientId]) personasCache[recipientId] = {};
  if (!personasCache[recipientId][domainKey]) personasCache[recipientId][domainKey] = {};
  const clean = sanitizeForPersona(answers);
  personasCache[recipientId][domainKey].last_choice = clean;
  try {
    fs.writeFileSync(path.join(PERSONA_DIR, `${recipientId}.json`), JSON.stringify(personasCache[recipientId], null, 2));
  } catch (e) { console.error(`Erro ao salvar last_choice para ${recipientId}: ${e.message}`); }

  // Apresenta página inicial (3 itens) com CTA
  await presentRecommendations(recipientId, places, 0);

  // Métricas: registra a busca realizada
  try {
    metrics.recordSearch({ type, lat, lng, keyword: answers.keyword || '' });
  } catch (_) {}

    // Limpa estado de refinamento (já processado)
    delete state.refinement;
    delete state.awaiting_location_type;
    delete state.awaiting_location_text;
    delete state.awaitingLocation;
  } finally {
    delete state.isFinalizing; // Sempre limpa a flag de proteção
  }
}

// --- Servidor Express ---
const app = express();
app.use(express.json());

function requireAdmin(req, res, next) {
  // Autenticação desativada: painel admin e métricas acessíveis sem secret.
  // Mantemos a função por compatibilidade de assinatura.
  return next();
}

// Arquivos estáticos (painel admin e outros assets)
try {
  if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
  }
} catch (_) {}

// Rota do painel admin (HTML)
app.get('/admin', (req, res) => {
  try {
    const filePath = path.join(PUBLIC_DIR, 'admin.html');
    return res.sendFile(filePath);
  } catch (err) {
    try { console.error('[ADMIN_PAGE]', err?.message || err); } catch (_) {}
    return res.status(500).send('Falha ao carregar painel admin');
  }
});

// Rota da página de chat web
app.get('/chat', (req, res) => {
  try {
    const filePath = path.join(PUBLIC_DIR, 'chat.html');
    return res.sendFile(filePath);
  } catch (err) {
    try { console.error('[CHAT_PAGE]', err?.message || err); } catch (_) {}
    return res.status(500).send('Falha ao carregar página de chat');
  }
});

// Rota da página técnica
app.get('/tech', (req, res) => {
  try {
    const filePath = path.join(PUBLIC_DIR, 'tech.html');
    return res.sendFile(filePath);
  } catch (err) {
    try { console.error('[TECH_PAGE]', err?.message || err); } catch (_) {}
    return res.status(500).send('Falha ao carregar painel técnico');
  }
});

// Status rápido dos principais componentes
app.get('/tech/status', (req, res) => {
  const requiredEnv = {
    EVOLUTION_URL,
    EVOLUTION_API_KEY,
    INSTANCE,
    GOOGLE_MAPS_API_KEY,
    GEMINI_API_KEY,
  };
  const missing = Object.entries(requiredEnv)
    .filter(([, v]) => !v || String(v).trim() === '')
    .map(([k]) => k);

  let metricsOk = true;
  let metricsSummary = null;
  try {
    metricsSummary = metrics.getSummary();
  } catch (e) {
    metricsOk = false;
  }

  const components = {
    env: {
      name: 'Variáveis de ambiente',
      ok: missing.length === 0,
      description: 'Configuração mínima necessária para a IA funcionar.',
      summary: missing.length === 0 ? 'Todas as variáveis obrigatórias estão definidas.' : `Faltando: ${missing.join(', ')}`,
    },
    gemini: {
      name: 'Gemini (Google Generative AI)',
      ok: !!model,
      description: 'Modelo usado para respostas adaptativas e pequenas inteligências.',
      summary: model ? `Modelo carregado: ${GEMINI_MODEL || 'desconhecido'}` : 'Modelo não está configurado ou falhou ao iniciar.',
    },
    maps: {
      name: 'Google Maps API',
      ok: !!GOOGLE_MAPS_API_KEY,
      description: 'Usado para buscar bares/restaurantes e detalhes de lugares.',
      summary: GOOGLE_MAPS_API_KEY ? 'Chave presente no ambiente.' : 'GOOGLE_MAPS_API_KEY ausente.',
    },
    evolution: {
      name: 'Evolution API',
      ok: !!EVOLUTION_URL && !!EVOLUTION_API_KEY,
      description: 'Gateway de mensagens do WhatsApp.',
      summary: EVOLUTION_URL ? `URL configurada: ${EVOLUTION_URL}` : 'EVOLUTION_URL ausente.',
    },
    db: {
      name: 'Banco / Métricas',
      ok: metricsOk,
      description: 'Leitura básica de métricas agregadas.',
      summary: metricsOk ? 'Leitura de métricas OK.' : 'Falha ao ler métricas pela função metrics.getSummary().',
    },
  };

  return res.json({
    lastCheck: new Date().toISOString(),
    components,
    metricsSample: metricsSummary || undefined,
  });
});

// Testes detalhados por componente
app.get('/tech/test', async (req, res) => {
  const target = String(req.query.target || '').toLowerCase();
  const out = { target };

  try {
    if (!target || target === 'env') {
      const requiredEnv = {
        EVOLUTION_URL,
        EVOLUTION_API_KEY,
        INSTANCE,
        GOOGLE_MAPS_API_KEY,
        GEMINI_API_KEY,
      };
      const missing = Object.entries(requiredEnv)
        .filter(([, v]) => !v || String(v).trim() === '')
        .map(([k]) => k);
      out.ok = missing.length === 0;
      out.detail = missing.length === 0
        ? 'Todas as variáveis obrigatórias estão definidas.'
        : `Variáveis ausentes: ${missing.join(', ')}`;
      return res.json(out);
    }

    if (target === 'gemini') {
      if (!model) {
        out.ok = false;
        out.detail = 'Modelo Gemini não foi inicializado (verifique GEMINI_API_KEY e GEMINI_MODEL).';
        return res.json(out);
      }
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const r = await model.generateContent('Responda apenas com OK.');
        clearTimeout(timeoutId);
        const txt = (await r.response.text()).trim();
        out.ok = !!txt;
        out.detail = `Resposta do modelo: ${txt}`;
      } catch (e) {
        out.ok = false;
        out.detail = `Erro ao chamar Gemini: ${e?.message || String(e)}`;
      }
      return res.json(out);
    }

    if (target === 'maps') {
      if (!GOOGLE_MAPS_API_KEY) {
        out.ok = false;
        out.detail = 'GOOGLE_MAPS_API_KEY não configurada.';
        return res.json(out);
      }
      try {
        const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
        const params = {
          query: 'bar',
          location: '-15.7801,-47.9292',
          radius: 500,
          key: GOOGLE_MAPS_API_KEY,
        };
        const r = await axios.get(url, { params, timeout: 7000 });
        const status = r.data?.status;
        out.ok = status === 'OK' || status === 'ZERO_RESULTS';
        out.detail = `Status da API: ${status}. Resultados: ${(r.data?.results || []).length}`;
      } catch (e) {
        out.ok = false;
        out.detail = `Erro ao chamar Google Maps: ${e?.response?.status || ''} ${e?.message || e}`;
      }
      return res.json(out);
    }

    if (target === 'evolution') {
      if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
        out.ok = false;
        out.detail = 'EVOLUTION_URL ou EVOLUTION_API_KEY não configurados.';
        return res.json(out);
      }
      try {
        const url = `${EV_URL_BASE}/status`;
        const r = await axios.get(url, {
          headers: { apikey: EVOLUTION_API_KEY },
          timeout: 7000,
        });
        out.ok = r.status === 200;
        out.detail = `Status HTTP: ${r.status}. Corpo: ${JSON.stringify(r.data).slice(0, 500)}`;
      } catch (e) {
        out.ok = false;
        const status = e?.response?.status;
        const body = e?.response?.data;
        out.detail = `Erro ao chamar Evolution: ${status || ''} ${e?.message || e}. Corpo: ${JSON.stringify(body).slice(0, 500)}`;
      }
      return res.json(out);
    }

    if (target === 'db' || target === 'metrics') {
      try {
        const summary = metrics.getSummary();
        out.ok = true;
        out.detail = `Leitura de métricas OK. Amostra: ${JSON.stringify(summary).slice(0, 800)}`;
      } catch (e) {
        out.ok = false;
        out.detail = `Erro ao ler métricas: ${e?.message || e}`;
      }
      return res.json(out);
    }

    out.ok = false;
    out.detail = `Alvo desconhecido: ${target}. Use env, gemini, maps, evolution ou db.`;
    return res.json(out);
  } catch (err) {
    out.ok = false;
    out.detail = `Falha interna no teste: ${err?.message || err}`;
    return res.json(out);
  }
});

app.post('/webhook', async (req, res) => {
  const data = req.body;
  console.log("📩 Mensagem recebida:", JSON.stringify(data, null, 2));

  try {
    if (data.event === "messages.upsert") {
      const messageData = data.data;
      const from = messageData.key?.remoteJid || messageData.from;
      const messageId = messageData.key?.id;
      // Ignora mensagens enviadas pela própria IA/bot para evitar loops e repetições
      if (messageData.key?.fromMe) {
        try { console.log('[WEBHOOK] Ignorando mensagem fromMe para', from, messageId); } catch (_) {}
        return res.sendStatus(200);
      }
      let userMessage = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text;
      const locMessage = messageData.message?.locationMessage;
      const audioMessage = messageData.message?.audioMessage;
      try { console.log('[FLOW] status=%s hasText=%s hasLoc=%s hasAudio=%s', messageData.status || 'N/A', !!userMessage, !!locMessage, !!audioMessage); } catch (_) {}

      // Se veio áudio sem texto, tenta transcrever com Google Speech-to-Text
      if (!userMessage && audioMessage) {
        try {
          // A Evolution costuma enviar o áudio já em base64 em message.base64
          // e, em alguns casos, em audioMessage.base64. A URL .enc é criptografada
          // e não deve ser enviada diretamente ao Google STT.
          let audioBase64 = messageData.message?.base64 || audioMessage.base64 || null;

          if (!audioBase64) {
            try { console.warn('[AUDIO] Nenhum campo base64 disponível para áudio; ignorando transcrição'); } catch (_) {}
          }

          if (audioBase64) {
            const transcript = await transcribeAudioWithGoogle(audioBase64, audioMessage.mimetype);
            if (transcript) {
              userMessage = transcript;
              try { console.log('[AUDIO] Transcrição obtida:', transcript); } catch (_) {}
            }
          }

          if (!userMessage) {
            const fallback = 'Recebi seu áudio, mas não consegui entender direitinho o que foi dito. Se puder, escreve rapidinho o que você está buscando (bar, restaurante, região ou dúvida).';
            await sendMessage(from, fallback);
            return res.sendStatus(200);
          }
        } catch (e) {
          try { console.error('[AUDIO] Falha ao processar áudio:', e?.response?.data || e?.message || e); } catch (_) {}
          const fallback = 'Recebi seu áudio, mas não consegui entender direitinho o que foi dito. Se puder, escreve rapidinho o que você está buscando (bar, restaurante, região ou dúvida).';
          try { await sendMessage(from, fallback); } catch (_) {}
          return res.sendStatus(200);
        }
      }

      // Fluxo simplificado: captura de nome quando aguardando apenas o nome do usuário
      if (userMessage && userState[from]?.awaiting_name) {
        const nm = userMessage.replace(/[^\p{L}\s'-]/gu, '').trim();
        if (nm) {
          setUserName(from, nm);
        }
        userState[from].awaiting_name = false;
        const name = getUserName(from) || nm || 'parceiro';
        const askIntent = `Prazer te conhecer, ${name}! Eu sou a I.aê, uma IA que te ajuda a encontrar bares e restaurantes do seu jeito. Quer começar com *bar* ou *restaurante* agora?`;
        await sendMessage(from, askIntent);
        if (!userState[from]) userState[from] = { conversationHistory: [] };
        if (!Array.isArray(userState[from].conversationHistory)) userState[from].conversationHistory = [];
        userState[from].conversationHistory.push({ role: 'bot', message: askIntent });
        userState[from].awaiting_intent_choice = { asked: true, ts: Date.now() };
        return res.sendStatus(200);
      }

      if (!userState[from]) userState[from] = { conversationHistory: [] };
      // Guarda instanceId recebido no webhook para usar nas chamadas à Evolution API
      if (data.instanceId) userState[from].instanceId = data.instanceId;

      if (from) metrics.recordUser(from);
      const nowTs = Date.now();
      const prevLastActive = userState[from].lastActive || 0;
      const isResumeAfterInactivity = !!prevLastActive && (nowTs - prevLastActive) > RESUME_GREET_MS;
      userState[from].lastActive = nowTs;

      // Confirma leitura (read receipt) assim que recebermos
      try { await markAsRead(from, messageId); } catch (_) {}

      // Idempotência: evita processar a mesma mensagem repetida (incluindo localização)
      if (messageId) {
        if (userState[from].lastMsgId === messageId) {
          try { console.log('[IDEMP] Ignorando mensagem duplicada', from, messageId); } catch (_) {}
          return res.sendStatus(200);
        }
        userState[from].lastMsgId = messageId;
      }
      
      // Controle adicional para localizações: verifica se as coordenadas são muito próximas da última
      if (locMessage) {
        const { degreesLatitude, degreesLongitude } = locMessage;
        const lastLoc = userState[from].lastLocation;
        if (lastLoc) {
          const dist = haversineKm(degreesLatitude, degreesLongitude, lastLoc.lat, lastLoc.lng);
          if (dist < 0.1) { // Menos de 100 metros
            try { console.log('[IDEMP] Ignorando localização duplicada próxima', from, degreesLatitude, degreesLongitude); } catch (_) {}
            return res.sendStatus(200);
          }
        }
        userState[from].lastLocation = { lat: degreesLatitude, lng: degreesLongitude, ts: Date.now() };
      }
      if (userMessage) userState[from].conversationHistory.push({ role: 'user', message: userMessage });
      if (userMessage) { try { await detectAndUpdateMood(from, userMessage); } catch (_) {} }
      if (userMessage) { try { await saveMessage(from, 'user', userMessage); } catch (_) {} }
      if (userMessage) { try { await learnPreferences(from, userMessage); } catch (_) {} }
      
      // Regra específica: qualquer pergunta sobre carnaval de Brasília
      if (userMessage) {
        const m = userMessage
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const mentionsCarnaval = m.includes('carnaval');
        const mentionsBrasilia = m.includes('brasilia') || m.includes('bsb') || m.includes('df');

        if (mentionsCarnaval && mentionsBrasilia) {
          const carnavalReply = `🎉 IAÊ?! VAMOS DE CARNAVAL? 🎉\n\nSe você quer carnaval, então toma!\nEm parceria com o @deubombrasilia, o @iae.bsb traz a lista de carnaval mais desejada de Brasília! 🥳🔥\n👉 Siga nossos perfis e fique por dentro de tudo!\n\n🗓️ AGENDA DE FESTAS & BLOCOS\n\n🎭 JANEIRO\n\n📅 17/01 (sábado)\n🎶 Pré-Carnaval Galpão 17 com Bloco Eduardo e Mônica\n📍 Galpão 17\n💰 Pago\n\n📅 31/01\n🎉 Esquenta de Carnaval – Texxas Bar\n📍 Texxas Bar\n💰 Pago\n\n🎭 FEVEREIRO\n\n📅 07/02 • a partir das 16h\n🎺 Bloco do MY (Esquenta)\n📍 Clube ASCADE\n💰 Pago\n\n📅 07/02\n🎈 Bloquinho da GR\n📍 Local a definir\n💰 Pago\n\n📅 07/02 (sábado)\n🥁 Bloco do Pretinho\n📍 Varjão\n🆓 Gratuito\n\n📅 07/02 (sábado)\n🎸 Pré-Carnaval da Banda Flexão\n⏰ A partir das 14h\n📍 Praça da QI 09 – Guará I\n🆓 Gratuito\n\n📅 13/02\n🍾 Suite Pee Folia – Bloco BYOB\n📍 Trend’s Bar\n💰 Pago\n\n📅 14/02\n🔥 O Bloco da Fervo\n📍 Local a definir\n💰 Pago\n\n📅 15/02 (domingo)\n👠✨ Bloco das Montadas\n📍 Museu Nacional da República\n🆓 Gratuito\n\n📅 21/02 (sábado)\n♿🎶 Bloco do Inclusão\n📍 Varjão\n🆓 Gratuito\n\n🎭 MARÇO\n\n📅 07/03\n🥳 Bloco do MY (Ressaca)\n📍 Clube ASCADE\n💰 Pago\n\n⚠️ Datas, locais e formatos podem sofrer alterações.\n👉 Se tiver algo errado ou faltando, avisa a gente!\n🎉 @deubombrasilia 🤝 @iae.bsb`;

          await sendMessage(from, carnavalReply);
          userState[from].conversationHistory.push({ role: 'bot', message: carnavalReply });
          return res.sendStatus(200);
        }
      }
      // Regra específica: pergunta sobre onde será o lançamento do Ia.ê
      if (userMessage) {
        const msgNorm = userMessage
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .replace(/[^a-z0-9\s]/g, ' ') // remove pontuação e deixa só letras/números/espaço
          .replace(/\s+/g, ' ') // normaliza espaços
          .trim();

        const hasLaunch = msgNorm.includes('lancamento');
        const hasIae = msgNorm.includes('iae') || msgNorm.includes('ia e') || msgNorm.includes('iae ');
        const asksWhere = msgNorm.includes('onde') || msgNorm.includes('aonde') || msgNorm.includes('local');

        const asksLaunchPlace = hasLaunch && hasIae && asksWhere;

        let shouldAnswerLaunch = asksLaunchPlace;

        if (!shouldAnswerLaunch) {
          try {
            const clsPrompt = `Classifique a intenção desta mensagem. Responda exatamente com uma palavra: "launch_iae" se o usuário estiver perguntando onde ou quando será o lançamento do Ia.ê (evento de lançamento da IA), ou "outro" caso contrário. Mensagem: "${userMessage}"`;
            const r = await Promise.race([
              model.generateContent(clsPrompt),
              new Promise((resolve) => setTimeout(() => resolve(null), 1200))
            ]);
            if (r) {
              const t = (await r.response.text()).trim().toLowerCase();
              if (t.includes('launch_iae')) shouldAnswerLaunch = true;
            }
          } catch (_) {}
        }

        if (shouldAnswerLaunch) {
          const replyLaunch = 'Que felicidade te contar! 🎉 O lançamento do Ia.ê vai ser no dia *8 de dezembro*, a partir das *19h*, nesse local: https://maps.app.goo.gl/dH1SkTPjCgBgD5ZTA';
          await sendMessage(from, replyLaunch);
          userState[from].conversationHistory.push({ role: 'bot', message: replyLaunch });
          return res.sendStatus(200);
        }
      }
      // --- Saudação de retomada após inatividade prolongada ---
      if (userMessage && isResumeAfterInactivity) {
        try {
          const name = getUserName(from);
          const greet = name
            ? `Oi, ${name}! Quanto tempo sem a gente se falar 😄 Eu sou a I.aê, uma IA que te indica bares e restaurantes do seu jeito. Bora ver um *bar* ou *restaurante* hoje?`
            : `Oi! Quanto tempo sem a gente se falar 😄 Eu sou a I.aê, uma IA que te indica bares e restaurantes do seu jeito. Bora ver um *bar* ou *restaurante* hoje?`;
          await sendMessage(from, greet);
          userState[from].conversationHistory.push({ role: 'bot', message: greet });
          userState[from].awaiting_intent_choice = { asked: true, ts: Date.now() };
          return res.sendStatus(200);
        } catch (_) { /* ignore resume greet errors */ }
      }

      // --- Primeiro contato: fluxos para novos usuários (sem entrevista inicial) ---
      if (userMessage) {
        // Menção direta a parceiro pelo nome: responde com detalhes imediatamente
        try {
          const sponsorHit = detectSponsorMention(userMessage);
          if (sponsorHit && sponsorHit.place_id) {
            const placeStub = { place_id: sponsorHit.place_id, name: sponsorHit.nome };
            const details = await getPlaceDetails(sponsorHit.place_id);
            // Mostra endereço por padrão + extras do parceiro
            const reply = formatInfoReply(placeStub, details, 'address');
            await sendMessage(from, reply);
            userState[from]?.conversationHistory?.push?.({ role: 'bot', message: reply });
            return res.sendStatus(200);
          }
        } catch (_) { /* ignore mention errors */ }

        const hasPersonaEarly = !!(personasCache[from]?.nome || personasCache[from]?.bar || personasCache[from]?.rest);
        const noFlow = !userState[from]?.awaiting_intent_choice && !userState[from]?.interview && !userState[from]?.refinement && !userState[from]?.awaiting_name;
        const hasHistory = Array.isArray(userState[from]?.conversationHistory) && userState[from].conversationHistory.length > 0;
        // Só trata como "primeiro contato" absoluto se não houver persona nem histórico prévio
        if (!hasPersonaEarly && noFlow && !hasHistory) {
          // Fluxo simplificado: se ainda não temos nome, perguntamos apenas o nome uma única vez
          if (!userState[from]) userState[from] = { conversationHistory: [] };
          if (!Array.isArray(userState[from].conversationHistory)) userState[from].conversationHistory = [];
          const askName = 'Oi! Eu sou a I.aê, uma inteligência artificial que te ajuda a encontrar bares e restaurantes do seu jeito. Pra começar, como posso te chamar?';
          await sendMessage(from, askName);
          userState[from].conversationHistory.push({ role: 'bot', message: askName });
          userState[from].awaiting_name = true;
          return res.sendStatus(200);
        }
      }

      // --- Saudações: pergunta direto sobre bar/restaurante, sem entrevista inicial ---
      if (userMessage && isGreeting(userMessage)) {
        // Small talk tem precedência para não forçar onboarding
        if (isSmallTalk(userMessage)) {
          await handleSmallTalk(from, userMessage);
          return res.sendStatus(200);
        }
        const name = getUserName(from);
        const greetAsk = name
          ? `E aí, ${name}! Eu sou a I.aê, uma IA parceira de rolê que te indica bares e restaurantes com a sua cara 🍻🍽️\nMe conta: hoje tá mais na vibe de *bar* ou *restaurante*?`
          : 'Oi! Eu sou a I.aê, uma IA parceira de rolê que te indica bares e restaurantes do jeitinho que você curte 🍻🍽️\nPra começar, você prefere ver *bar* ou *restaurante* hoje?';
        if (!userState[from]) userState[from] = { conversationHistory: [] };
        if (!Array.isArray(userState[from].conversationHistory)) userState[from].conversationHistory = [];
        await sendMessage(from, greetAsk);
        userState[from].conversationHistory.push({ role: 'bot', message: greetAsk });
        userState[from].awaiting_intent_choice = { asked: true, ts: Date.now() };
        return res.sendStatus(200);
      }

      // Fluxos de onboarding estendidos foram desativados; seguimos direto para escolha de intenção/bar/restaurante.

      // --- Escolha explícita: bar vs restaurante ---
      if (userMessage && userState[from]?.awaiting_intent_choice) {
        let intent = detectChosenIntent(userMessage);
        if (!intent) {
          try {
            const parsed = await parseInitialIntent(userMessage, personasCache[from]);
            if (parsed?.intention === 'bar' || parsed?.intention === 'restaurante') intent = parsed.intention;
          } catch (_) {}
        }
        if (intent) {
          delete userState[from].awaiting_intent_choice;
          // Se temos localização pendente, usa já
          const pend = userState[from].pendingLocation;
          if (pend && typeof pend.lat === 'number' && typeof pend.lng === 'number') {
            userState[from].refinement = { type: intent, answers: {}, lat: pend.lat, lng: pend.lng };
            delete userState[from].pendingLocation;
            await finalizeSearch(from);
            return res.sendStatus(200);
          }
          // Caso contrário, inicia o refinamento dinâmico normal
          await startDynamicRefinement(from, userMessage, intent, {});
          return res.sendStatus(200);
        } else {
          const askWhichHint2 = 'Confirme de forma simpática se prefere bar ou restaurante neste momento. Não peça localização.';
          const msg2 = await sendAdaptive(from, askWhichHint2);
          userState[from].conversationHistory.push({ role: 'bot', message: msg2 });
          return res.sendStatus(200);
        }
      }

      // --- Resposta ao tipo de localização (perto vs outro lugar) e texto de lugar ---
      if (userMessage) {
        // --- Seleção e pedidos de informação sobre itens recomendados ---
        try {
          const cta = userState[from]?.cta;
          const topic = detectInfoIntent(userMessage);
          const sel = parseSelectionIndex(userMessage);
          // Se usuário apenas escolheu 1/2/3, salva escolha e pergunta o que quer saber
          if (!topic && cta && sel) {
            const idx = Math.max(1, Math.min(3, sel)) - 1;
            const pageStart = cta.index || 0;
            const place = cta.ordered?.[pageStart + idx];
            if (place) {
              userState[from].selectedPlace = place;
              const name = getUserName(from) || 'parceiro';
              const msg = `Boa, ${name}! Você escolheu *${place.name}*. O que você quer saber? Posso te dizer preço (faixa), horário, telefone ou site.`;
              await sendMessage(from, msg);
              userState[from].conversationHistory.push({ role: 'bot', message: msg });
              return res.sendStatus(200);
            }
          }
          // Se perguntou informação (com ou sem número), tenta responder
          if (topic && cta) {
            let place = null;
            if (sel) {
              const idx = Math.max(1, Math.min(3, sel)) - 1;
              const pageStart = cta.index || 0;
              place = cta.ordered?.[pageStart + idx] || null;
            }
            if (!place) place = userState[from]?.selectedPlace || null;
            if (place) {
              const details = await getPlaceDetails(place.place_id);
              const reply = formatInfoReply(place, details, topic);
              await sendMessage(from, reply);
              userState[from].conversationHistory.push({ role: 'bot', message: reply });
              return res.sendStatus(200);
            } else {
              const ask = 'Me diga primeiro qual dos itens você quer: 1, 2 ou 3. Depois posso te informar preço, horário, telefone ou site.';
              await sendMessage(from, ask);
              userState[from].conversationHistory.push({ role: 'bot', message: ask });
              return res.sendStatus(200);
            }
          }

          // Fallback: usuário perguntou info (ex.: "onde fica X") sem ter CTA/seleção
          if (topic && !userState[from]?.cta) {
            const candidate = await resolvePlaceByName(userMessage);
            if (candidate && candidate.place_id) {
              const details = await getPlaceDetails(candidate.place_id);
              const reply = formatInfoReply(candidate, details, topic);
              await sendMessage(from, reply);
              userState[from].conversationHistory.push({ role: 'bot', message: reply });
              return res.sendStatus(200);
            }
          }
        } catch (_) { /* ignore */ }

        // Refinamento rápido: usuário pede especificamente bares que passam futebol/jogos
        try {
          const state = userState[from];
          if (state && state.cta && detectFootballFilter(userMessage) && state.lastSearch && state.lastSearch.lat && state.lastSearch.lng) {
            const base = state.lastSearch;
            const currentAnswers = { ...(base.answers || {}) };
            const extraKw = ' futebol jogo jogos telão telao';
            const prevKw = currentAnswers.keyword || currentAnswers.filters?.keyword || '';
            const combinedKw = [prevKw, extraKw].filter(Boolean).join(' ').trim();
            if (combinedKw) {
              if (!currentAnswers.filters) currentAnswers.filters = {};
              currentAnswers.keyword = combinedKw;
              currentAnswers.filters.keyword = combinedKw;
            }
            state.refinement = {
              type: base.type || 'bar',
              answers: currentAnswers,
              lat: base.lat,
              lng: base.lng
            };
            const name = getUserName(from) || 'parceiro';
            const confirm = `Boa, ${name}! Vou procurar de novo focando em bares que costumam passar jogos por aí. Segura um pouquinho que já te trago novas opções ⚽📺`;
            await sendMessage(from, confirm);
            state.conversationHistory.push({ role: 'bot', message: confirm });
            await finalizeSearch(from);
            return res.sendStatus(200);
          }
        } catch (_) { /* ignore football refinement errors */ }

        const handledLocType = await handleLocationTypeResponse(from, userMessage);
        if (handledLocType) return res.sendStatus(200);
        const handledTextPlace = await handleTextPlaceSearch(from, userMessage);
        if (handledTextPlace) return res.sendStatus(200);
      }

      // --- Se chegou uma localização (lat/lng) ---
      if (locMessage) {
        try { console.log('[WEBHOOK] locationMessage recebido de', from, locMessage?.degreesLatitude, locMessage?.degreesLongitude); } catch (_) {}
        // Aceita se já estamos aguardando coords ou já há um refinement em andamento
        if (userState[from]?.refinement || userState[from]?.awaitingLocation || userState[from]?.awaiting_location_type) {
          const { degreesLatitude, degreesLongitude } = locMessage;
          if (!userState[from].refinement) {
            const t = userState[from]?.awaiting_location_type?.type || 'bar';
            const ans = userState[from]?.awaiting_location_type?.answers || {};
            userState[from].refinement = { type: t, answers: ans, lat: null, lng: null };
          }
          userState[from].refinement.lat = degreesLatitude;
          userState[from].refinement.lng = degreesLongitude;
          userState[from].awaitingLocation = false;
          // Mostra parceiros por perto imediatamente
          try { await sendNearbySponsored(from, degreesLatitude, degreesLongitude); } catch (_) {}
          await finalizeSearch(from);
          try { console.log('[FLOW] finalizeSearch ok for', from); } catch (_) {}
          return res.sendStatus(200);
        } else {
          // Guarda a localização para usar após o usuário escolher bar/restaurante
          const { degreesLatitude, degreesLongitude } = locMessage;
          userState[from].pendingLocation = { lat: degreesLatitude, lng: degreesLongitude, ts: Date.now() };
          const askWhichHint3 = 'Convide o usuário, de forma breve e amigável, a escolher entre bar ou restaurante por perto. Não peça localização novamente (já recebida).';
          const msg3 = await sendAdaptive(from, askWhichHint3);
          userState[from].conversationHistory.push({ role: 'bot', message: msg3 });
          userState[from].awaiting_intent_choice = { asked: true, ts: Date.now() };
          // Mostra parceiros por perto enquanto o usuário escolhe
          try { await sendNearbySponsored(from, degreesLatitude, degreesLongitude); } catch (_) {}
          return res.sendStatus(200);
        }
      }
      // Fallback adaptativo: se nenhuma rota acima tratou a mensagem
      if (userMessage) {
        // Antes de cair na resposta genérica, tenta entender se é um pedido
        // de recomendação de bar/restaurante usando o modelo (parseInitialIntent).
        // Isso permite compreender pedidos livres como "boteco barato" sem depender
        // apenas de palavras exatas como "bar" ou "restaurante".
        try {
          const parsed = await parseInitialIntent(userMessage, personasCache[from]);
          const intent = parsed?.intention;
          const initialPrefs = parsed?.preferences || {};

          if (intent === 'bar' || intent === 'restaurante') {
            // Se já houver uma localização pendente, usa direto para buscar
            const pend = userState[from]?.pendingLocation;
            if (pend && typeof pend.lat === 'number' && typeof pend.lng === 'number') {
              userState[from].refinement = {
                type: intent,
                answers: initialPrefs,
                lat: pend.lat,
                lng: pend.lng
              };
              delete userState[from].pendingLocation;
              await finalizeSearch(from);
              return res.sendStatus(200);
            }

            // Caso contrário, inicia o refinamento dinâmico direto com a intenção
            await startDynamicRefinement(from, userMessage, intent, initialPrefs);
            return res.sendStatus(200);
          }
        } catch (_) {}

        // Tratamento especial para escolhas numéricas (1/2/3) sem CTA ativo,
        // para evitar respostas genéricas quando o usuário está tentando escolher.
        try {
          const sel = parseSelectionIndex(userMessage);
          const hasCta = !!userState[from]?.cta;
          if (sel && !hasCta) {
            const name = getUserName(from) || 'parceiro';
            const msgNum = `Parece que você tá escolhendo uma opção, ${name} 🙂 Pra eu te mostrar lugares certinhos, me fala primeiro se quer *bar* ou *restaurante* e em qual bairro/região.`;
            await sendMessage(from, msgNum);
            userState[from].conversationHistory.push({ role: 'bot', message: msgNum });
            return res.sendStatus(200);
          }
        } catch (_) {}

        // Se nada acima tratou, usa a resposta adaptativa genérica
        try {
          const reply = await generateAdaptiveReply(from, userMessage);
          await sendMessage(from, reply);
          return res.sendStatus(200);
        } catch (_) {}
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no fluxo do webhook para %s: %s", data.data?.key?.remoteJid || 'N/A', err.message);
    if (data.data?.key?.remoteJid || data.data?.from) {
      const errorMessage = "Putz, deu um erro inesperado aqui! Minha equipe já está de olho nisso. Por favor, tente novamente mais tarde. 🙏";
      await sendMessage(data.data?.key?.remoteJid || data.data?.from, errorMessage);
      userState[data.data?.key?.remoteJid || data.data?.from]?.conversationHistory.push({ role: 'bot', message: errorMessage });
    }
    res.sendStatus(500);
  }
});

// --- Inicialização com tratamento de erros ---
function startServer() {
  try {
    // Carrega personas, patrocinados e inicia métricas
    loadPersonasIntoCache();
    loadSponsored();
    metrics.init();

    // Limpa sessões inativas a cada 10 minutos (timeout: 45 minutos)
    const INACTIVITY_MS = 45 * 60 * 1000;
    setInterval(() => {
      const now = Date.now();
      for (const uid of Object.keys(userState)) {
        const last = userState[uid]?.lastActive || 0;
        if (last && (now - last) > INACTIVITY_MS) {
          delete userState[uid].refinement;
          delete userState[uid].awaiting_location_type;
          delete userState[uid].awaiting_location_text;
          delete userState[uid].awaitingLocation;
          delete userState[uid].awaiting_filter;
          delete userState[uid].cta;
        }
      }
    }, 10 * 60 * 1000);

    // Cria servidor HTTP e WebSocket compartilhado
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws) => {
      let webUserId = null;
      try { console.log('[WS] Novo cliente conectado'); } catch (_) {}

      ws.on('message', async (msg) => {
        try {
          const raw = String(msg || '').trim();
          try { console.log('[WS] Mensagem recebida do cliente:', raw); } catch (_) {}

          let data;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            // Se não for JSON, ignora ou ecoa como texto simples
            return;
          }

          if (data.type === 'set_user_id' && data.userId) {
            webUserId = String(data.userId);
            try {
              ws.send(JSON.stringify({
                type: 'log',
                level: 'info',
                message: `ID de usuário associado: ${webUserId}`
              }));
            } catch (_) {}
            return;
          }

          // Trata mensagens de texto do chat web
          if (data.type === 'message' && data.content) {
            const uid = webUserId || data.userId || 'web_anon';
            try {
              // Adiciona um log no painel
              ws.send(JSON.stringify({
                type: 'log',
                level: 'info',
                message: `Mensagem do usuário (${uid}): ${data.content}`
              }));
            } catch (_) {}

            let replyText = 'Beleza!';
            try {
              const r = await generateAdaptiveReply(uid, data.content);
              if (typeof r === 'string' && r.trim()) replyText = r.trim();
            } catch (e) {
              try { console.error('[WS] Erro ao gerar resposta adaptativa:', e?.message || e); } catch (_) {}
            }

            try {
              ws.send(JSON.stringify({
                type: 'message',
                content: replyText,
                isUser: false
              }));
            } catch (_) {}
            return;
          }

          // Mensagens de localização vindas do chat web
          if (data.type === 'location' && typeof data.lat === 'number' && typeof data.lng === 'number') {
            const uid = webUserId || data.userId || 'web_anon';
            try {
              ws.send(JSON.stringify({
                type: 'log',
                level: 'info',
                message: `Localização recebida de ${uid}: (${data.lat.toFixed(5)}, ${data.lng.toFixed(5)})`
              }));
            } catch (_) {}

            const reply = `Recebi sua localização: latitude ${data.lat.toFixed(4)}, longitude ${data.lng.toFixed(4)}. Em breve vou usar isso para te mostrar bares e restaurantes por perto.`;
            try {
              ws.send(JSON.stringify({
                type: 'message',
                content: reply,
                isUser: false
              }));
            } catch (_) {}
            return;
          }
        } catch (err) {
          try { console.error('[WS] Erro ao processar mensagem do cliente:', err?.message || err); } catch (_) {}
          try {
            ws.send(JSON.stringify({
              type: 'log',
              level: 'error',
              message: 'Erro ao processar mensagem no servidor WebSocket.'
            }));
          } catch (_) {}
        }
      });

      ws.on('close', () => {
        try { console.log('[WS] Cliente desconectado'); } catch (_) {}
      });

      ws.on('error', (err) => {
        try { console.error('[WS] Erro na conexão:', err?.message || err); } catch (_) {}
      });
    });

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 IAE 2.0 está rodando com Evolution API na porta ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error);
    console.log('🔄 Tentando reiniciar em 5 segundos...');
    setTimeout(startServer, 5000);
  }
}

// Inicia o servidor
startServer();

// --- Global error handlers ---
process.on('unhandledRejection', (reason) => {
  try { console.error('[UNHANDLED_REJECTION]', reason?.stack || reason); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  try { console.error('[UNCAUGHT_EXCEPTION]', err?.stack || err?.message || err); } catch (_) {}
});

// --- Promoção de patrocinados ---
function promoteSponsoredOrder(places) {
  try {
    if (!Array.isArray(places) || places.length === 0 || !Array.isArray(sponsored) || sponsored.length === 0) return places;
    const byId = new Map(places.map(p => [p.place_id, p]));
    const presentSponsors = sponsored
      .filter(s => s.active && s.place_id && byId.has(s.place_id))
      .sort((a, b) => (a.prioridade || 99) - (b.prioridade || 99));

    const pinned = new Array(3).fill(null);
    for (const s of presentSponsors) {
      const prio = Math.max(1, Math.min(3, parseInt(s.prioridade, 10) || 99));
      const idx = prio - 1;
      if (!pinned[idx]) pinned[idx] = byId.get(s.place_id);
    }

    const pinnedSet = new Set(pinned.filter(Boolean).map(p => p.place_id));
    const rest = places.filter(p => !pinnedSet.has(p.place_id));
    const final = [];
    for (let i = 0; i < 3; i++) {
      if (pinned[i]) final.push(pinned[i]);
    }
    final.push(...rest);
    return final;
  } catch (_) { return places; }
}

// --- Health Check ---
app.get('/health', (req, res) => {
  const summary = (() => { try { return metrics.getSummary(); } catch (_) { return null; } })();
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    metrics: summary || undefined
  });
});

app.get('/admin/metrics', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;

    const [
      summary,
      userStats,
      userSeries,
      convStats,
      convSeries,
      activeUserStats,
      recentUsers,
      topKeywords,
      topPlaces,
      heatmap
    ] = await Promise.all([
      Promise.resolve().then(() => { try { return metrics.getSummary(); } catch (_) { return null; } }),
      getUserStats({ days }),
      getUserTimeSeries({ days }),
      getConversationStats({ days }),
      getConversationTimeSeries({ days }),
      getActiveUserStats({ days }),
      getRecentUsers({ limit: 15 }),
      Promise.resolve().then(() => { try { return metrics.getTop({ limit: 10 }); } catch (_) { return []; } }),
      Promise.resolve().then(() => { try { return metrics.getTopPlaces({ limit: 10 }); } catch (_) { return []; } }),
      Promise.resolve().then(() => { try { return metrics.getHeatmap({ hours: days * 24 }); } catch (_) { return []; } }),
    ]);
    const placeShownCounts = (() => { try { return metrics.getPlaceShownCounts(); } catch (_) { return {}; } })();
    const funnelRecommendationsTotal = Object.values(placeShownCounts || {}).reduce((acc, v) => acc + (Number(v) || 0), 0);
    const funnelRecommendationsPlaces = Object.keys(placeShownCounts || {}).length;

    res.json({
      periodDays: days,
      kpis: {
        users: {
          total: Number(userStats.totalUsers || 0),
          newInPeriod: Number(userStats.newUsersPeriod || 0),
          firstUserTs: userStats.firstUserTs || null,
          lastUserTs: userStats.lastUserTs || null,
          byDay: userSeries,
          activeToday: Number(activeUserStats?.activeToday || 0),
          activePeriod: Number(activeUserStats?.activePeriod || 0),
          avgMessagesPerUser: (() => {
            const totalUsers = Number(userStats.totalUsers || 0) || 1;
            const totalMsgs = Number(convStats.totalMessages || 0) || 0;
            return totalMsgs / totalUsers;
          })(),
          recent: recentUsers || [],
        },
        messages: {
          total: Number(convStats.totalMessages || 0),
          inPeriod: Number(convStats.messagesPeriod || 0),
          byDay: convSeries,
        },
        searches: {
          total: summary?.totalSearches ?? null,
          last24h: summary?.searches24h ?? null,
          byHourLast24h: (() => {
            try { return metrics.getTimeSeries({ hours: 24 }); } catch (_) { return []; }
          })(),
          topKeywords,
        },
        places: {
          top: topPlaces,
          heatmap,
          top3: topPlaces.slice(0, 3),
        },
        funnel: {
          usersTotal: Number(userStats.totalUsers || 0),
          usersActivePeriod: Number(activeUserStats?.activePeriod || 0),
          messagesTotal: Number(convStats.totalMessages || 0),
          messagesInPeriod: Number(convStats.messagesPeriod || 0),
          searchesTotal: summary?.totalSearches ?? 0,
          searchesLast24h: summary?.searches24h ?? 0,
          recommendationsTotal: funnelRecommendationsTotal,
          recommendationsPlaces: funnelRecommendationsPlaces,
        },
      },
    });
  } catch (err) {
    try { console.error('[ADMIN_METRICS]', err?.stack || err?.message || err); } catch (_) {}
    res.status(500).json({ error: 'failed_to_compute_metrics' });
  }
});
