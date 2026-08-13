// ============================================================
// ai-server.mjs — 地震应急 AI 分析接口（代理 DeepSeek API）
// 用法：DEEPSEEK_API_KEY=sk-xxx node ai-server.mjs   （默认端口 9000）
// 接口：
//   POST /analyze  { mag, depth, epicenter, maxIntName }        -> 灾难级别 + 应急措施
//   POST /report   { maxIntName, affectedCount, affectedAreas } -> 受灾情况播报 + 避险指南
// ============================================================
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9000);

function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const keyFile = join(__dirname, 'deepseek.key');
  if (existsSync(keyFile)) {
    const k = readFileSync(keyFile, 'utf8').trim();
    if (k) return k;
  }
  return '';
}

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

async function callDeepSeekCore(system, user) {
  const key = loadKey();
  if (!key) {
    return { ok: false, detail: 'no-key', advice: '未配置 DeepSeek API Key，请在 deepseek.key 中填写。' };
  }
  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`DeepSeek ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const cleaned = content.replace(/```json|```/g, '').trim();
  try {
    return { ok: true, detail: 'ok', parsed: JSON.parse(cleaned) };
  } catch {
    return { ok: true, detail: 'text', parsed: { advice: cleaned.slice(0, 120) } };
  }
}

// ---------- /analyze：灾难级别 + 应急措施 ----------
async function analyze(d) {
  const system = [
    '你是一名专业的地震应急指挥播报员。',
    '请根据输入的地震参数，完成两件事：',
    '1. 估计灾难级别（用：轻微 / 中等 / 重大 / 特重大 四级，并给出 1~4 的 levelCode）。',
    '2. 用中文写一段简洁、口语化、适合语音播报的应急措施（60字以内，不要用序号）。',
    '只输出 JSON，格式严格为：{"level":"重大","levelCode":3,"advice":"..."}',
  ].join('\n');
  const user = [
    `地震参数如下：`,
    `震级：M${d.mag}`,
    `震源深度：${d.depth} km`,
    `震源位置：${d.epicenter || '未知'}`,
    `预计最大震度：${d.maxIntName || '未知'}`,
    `请评估灾难级别并给出应急措施播报。`,
  ].join('\n');

  const r = await callDeepSeekCore(system, user);
  if (!r.ok) return { level: '未知', levelCode: 0, advice: r.advice, detail: r.detail };
  const p = r.parsed;
  return { level: p.level || '未知', levelCode: Number(p.levelCode) || 0, advice: p.advice || '请保持冷静，注意安全。', detail: r.detail };
}

// ---------- /report：受灾情况播报 + 避险指南 ----------
async function report(d) {
  const system = [
    '你是地震受灾情况播报员。根据受灾数据，输出三部分：',
    '1. situation：受灾情况播报，口语化、简洁，说明哪些地区受灾、震度多大、范围多大。',
    '2. guide：针对当前受灾情况的避险指南，口语化、具体可执行，60字以内。',
    '3. advice：把 situation 和 guide 合并成一段 90 字以内、适合语音播报的话。',
    '只输出 JSON，格式严格为：{"situation":"...","guide":"...","advice":"..."}',
  ].join('\n');
  const user = [
    `当前受灾数据：`,
    `最大震度：${d.maxIntName || '未知'}`,
    `受灾区域数：${d.affectedCount || 0}`,
    `主要受灾地区：${d.affectedAreas || '暂无'}`,
    `请生成受灾情况播报和避险指南。`,
  ].join('\n');

  const r = await callDeepSeekCore(system, user);
  if (!r.ok) return { level: '受灾播报', situation: '', guide: '', advice: r.advice, detail: r.detail };
  const p = r.parsed;
  return {
    level: '受灾播报',
    situation: p.situation || '',
    guide: p.guide || '',
    advice: p.advice || (p.situation + ' ' + p.guide).trim(),
    detail: r.detail,
  };
}

// ---------- /social：政府与民间机构角色模拟播报（中日国情分开） ----------
const SOCIAL_ROLES_CN = [
  { name: '应急管理部', type: 'gov', prompt: '你是应急管理部发言人，发布一条地震应急处置的政府决策（启动应急响应级别、调派救援力量、发布预警等）。' },
  { name: '当地政府', type: 'gov', prompt: '你是受灾地政府发言人，发布一条当地应急动员与决策（转移群众、开放避难所、交通管制等）。' },
  { name: '央视新闻', type: 'media', prompt: '你是央视新闻记者，播报一条地震最新新闻快讯。' },
  { name: '新华社', type: 'media', prompt: '你是新华社记者，发布一条地震权威快讯。' },
  { name: '地震专家', type: 'expert', prompt: '你是地震专家，对本次地震做一句专业解读与提醒。' },
  { name: '民间救援队', type: 'civil', prompt: '你是民间救援队负责人，播报救援行动进展与呼吁。' },
  { name: '网络舆情', type: 'civil', prompt: '你是社交媒体地震信息汇总，播报公众关注点与传言澄清。' },
];

const SOCIAL_ROLES_JP = [
  { name: '気象庁', type: 'gov', prompt: '你是日本气象厅，发布紧急地震速报（地震の発生、震源、最大震度、津波の有無、注意喚起）。' },
  { name: '内閣府', type: 'gov', prompt: '你是日本内阁府灾害对策本部，发布政府应对决策（災害対策本部の設置、自衛隊派遣、支援物資等）。' },
  { name: '地方自治体', type: 'gov', prompt: '你是受灾地自治体，发布避难指示与应对（避難指示、避難所開設、安否確認等）。' },
  { name: 'NHK', type: 'media', prompt: '你是NHK新闻，播报地震最新ニュース速報。' },
  { name: '共同通信社', type: 'media', prompt: '你是共同通信社，发布地震ニュース速報。' },
  { name: '地震学者', type: 'expert', prompt: '你是地震学者（東大地震研究所等），对本次地震做专业解説と注意喚起。' },
  { name: '消防・自衛隊', type: 'civil', prompt: '你是消防/自卫队，播报救援活动の進展と呼びかけ。' },
  { name: 'SNS', type: 'civil', prompt: '你是日本社交媒体上的地震情報まとめ，播报公众关注点とデマ注意。' },
];

async function social(d) {
  const roles = d.region === 'japan' ? SOCIAL_ROLES_JP : SOCIAL_ROLES_CN;
  const r = roles[Math.floor(Math.random() * roles.length)];
  const isJp = d.region === 'japan';
  const sysBase = '你是地震应急播报系统中的「' + r.name + '」。' + r.prompt;
  const sysOut = isJp
    ? '用日语播报，70字以内，口语化。同时输出简体中文翻译 subtitle（供字幕显示，与日语内容意思一致）。只输出 JSON：{"role":"' + r.name + '","content":"日语播报内容","subtitle":"中文翻译"}'
    : '用中文，70字以内，口语化，直接说播报内容，不要任何解释。只输出 JSON：{"role":"' + r.name + '","content":"..."}';
  const system = sysBase + sysOut;
  const user = `当前地震情况：震级 M${d.mag || '?'}，震源 ${d.epicenter || '未知'}，最大震度 ${d.maxIntName || '未知'}，受灾区域：${d.affectedAreas || '暂无'}`;
  const res = await callDeepSeekCore(system, user);
  if (!res.ok) return { role: r.name, type: r.type, content: res.advice, subtitle: '', detail: res.detail };
  const p = res.parsed;
  return { role: p.role || r.name, type: r.type, content: p.content || p.advice || '', subtitle: p.subtitle || '', detail: res.detail };
}

// ---------- /chat：网友聊天小剧场（中日国情分开，全中文） ----------
async function chat(d) {
  const isJp = d.region === 'japan';
  const system = (isJp
    ? '你是日本网友在地震发生时于 LINE / X(推特) 上的群聊。模拟 12~15 个日本网友的聊天，要有真实群聊感：网友之间互相回复、接话，不要各说各的。内容按灾情发展递进。务必根据最大震度调整语气与互动：震度7/特大地震 → 极度恐慌、互相报平安、互诉经历、求助与生死关怀；震度5~6/强震 → 惊慌但有序、互相询问安危、分享震感、提醒避难；震度3~4/中小地震 → 淡定调侃、互相开玩笑、聊无关话题；震度1~2/小地震 → 轻微反应、互相吐槽、闲聊不以为意。可以自然提到具体设备与预警细节：手机緊急地震速報（运营商速报メール、倒计时警报）、电视 NHK 警报、Yahoo!防災或 NHK ニュース・防災等 App 推送、广播警报等，让聊天更真实。符合日本网络语境（緊急地震速報、避难所、NHK、电车停运、津波等），全部用简体中文输出。'
    : '你是中国网友在地震发生时于微信群 / 微博上的群聊。模拟 12~15 个中国网友的聊天，要有真实群聊感：网友之间互相回复、接话（如 A 问「大家还好吗」，B 回「我没事，你呢」），不要各说各的。内容按灾情发展递进。务必根据最大震度调整语气与互动：震度7/特大地震 → 极度恐慌、互相报平安、互诉经历、求助与生死关怀；震度5~6/强震 → 惊慌但有序、互相询问安危、分享震感、提醒避难；震度3~4/中小地震 → 淡定调侃、互相开玩笑、聊无关话题（天气、吃喝、日常）；震度1~2/小地震 → 轻微反应、互相吐槽、闲聊不以为意。可以自然提到具体设备与预警细节：小米/华为/OPPO/vivo 等手机自带的地震预警（倒计时、警报声）、小米电视或手环、小爱同学/天猫精灵等智能设备弹预警、地震预警 App 或微信小程序推送、运营商预警短信等，让聊天更真实。符合中国网络语境（朋友圈、地震预警 App、报平安、辟谣、救援等），用简体中文。')
    + '只输出 JSON：{"messages":[{"user":"网友昵称","text":"聊天内容"},...]}，12~15 条，每条 25 字以内，口语化，像真实网友聊天，昵称各不相同且像真实网名。';
  const user = `当前地震：震级 M${d.mag || '?'}，震源 ${d.epicenter || '未知'}，最大震度 ${d.maxIntName || '未知'}，受灾区域：${d.affectedAreas || '暂无'}`;
  const res = await callDeepSeekCore(system, user);
  if (!res.ok) return { messages: [], detail: res.detail };
  const p = res.parsed;
  return { messages: Array.isArray(p.messages) ? p.messages : [], detail: res.detail };
}

// ---------- /casualty：预估伤亡与财产损失（基于实时受灾区域） ----------
async function casualty(d) {
  const system = '你是地震灾害损失评估专家。根据已经受灾的区域及其震度，预估人口伤亡和财产损失。评估时务必考虑区域类型：北京、上海、广州、深圳、成都、重庆、杭州、武汉、西安、南京、天津、苏州、长沙、郑州、青岛、宁波、无锡、佛山、东莞、合肥、福州、厦门、昆明、大连、沈阳、济南、石家庄、哈尔滨、长春、南昌等中国一线及二线城市，以及东京、大阪、名古屋、横滨、福冈、札幌、京都、神户、川崎、广岛、仙台、新潟等日本大城市的城区人口密度高、经济总量大，同等震度下伤亡和损失比中小城市高 1~2 个数量级。参考量级：一二线城市核心区震度7 → 损失数万亿元、伤亡数万至数十万；震度6强 → 损失数千亿元、伤亡数千至数万；震度6弱 → 损失数百亿元、伤亡数百至数千；中小城市或农村震度5~6 → 损失数十至数百亿元、伤亡数十至数百。只输出 JSON：{"deaths":"约X人","injuries":"约X人","loss":"约X亿元"}，数字必须符合上述量级，不要任何解释。';
  const user = `已受灾区域及震度：${d.affectedDetail || '暂无受灾区域'}`;
  const res = await callDeepSeekCore(system, user);
  if (!res.ok) return { deaths: '--', injuries: '--', loss: '--', detail: res.detail };
  const p = res.parsed;
  return { deaths: p.deaths || '--', injuries: p.injuries || '--', loss: p.loss || '--', detail: res.detail };
}

// ---------- HTTP 服务 ----------
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/setkey') {
    try {
      const body = await readBody(req);
      const d = JSON.parse(body || '{}');
      if (!d.key || !d.key.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'key 为空' }));
        return;
      }
      writeFileSync(join(__dirname, 'deepseek.key'), d.key.trim(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && (req.url === '/analyze' || req.url === '/report' || req.url === '/social' || req.url === '/chat' || req.url === '/casualty')) {
    try {
      const body = await readBody(req);
      const d = JSON.parse(body || '{}');
      const result = req.url === '/analyze' ? await analyze(d) : (req.url === '/report' ? await report(d) : (req.url === '/social' ? await social(d) : (req.url === '/chat' ? await chat(d) : await casualty(d))));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ role: '系统', content: 'AI 分析失败：' + e.message, detail: 'error' }));
    }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  const hasKey = !!loadKey();
  console.log(`AI 接口已启动: http://127.0.0.1:${PORT}/analyze 和 /report`);
  console.log(`模型: ${MODEL}`);
  console.log(`API Key: ${hasKey ? '已配置' : '未配置（请填 deepseek.key 或设环境变量 DEEPSEEK_API_KEY）'}`);
});
