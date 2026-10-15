/**
 * 三餐 AI 营养师 —— 后端入口（Express + DeepSeek/Agnes AI）
 *
 * 骨架来源：vibeshot（声影印记）后端提炼的通用逻辑。
 * 本仓库与 vibeshot 完全独立：仓库、部署、数据库、环境变量全部隔离，
 * 仅复用经过验证的通用模块（鉴权链、限流、OSS、AI 调用链、虚拟支付）。
 *
 * 安全基线（2026-10-13 DeepSeek Key 被刷事件教训）：
 *   1. 所有消耗第三方额度的接口必须同时满足：登录 + 限流（RL.llmCostLimiter）
 *   2. 生产环境绝不配置 DEV_USER / DEV_PASS（开发登录后门）
 *   3. 全局限流挂在所有业务路由之前
 */
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import * as DB from './src/db.js';
import * as RL from './src/rate-limit.js';
import * as MEAL from './src/meal.js';

dotenv.config();

/**
 * 读取环境变量（惰性）。
 * ⚠️ 不在模块顶层固化 process.env：ESM import 静态提升会让业务模块
 *    在 dotenv.config() 之前求值，导致 .env 中的值读不到。
 */
function env(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 微信小程序登录配置
// ------------------------------------------------------------
// AppID / Secret 为敏感信息，仅存服务端环境变量，绝不入库/进前端。
// ============================================================
const WX_APPID = () => env('WX_APPID');
const WX_SECRET = () => env('WX_SECRET');

// 从请求头解析 Bearer token
function resolveToken(req: express.Request): string {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// 从 token 解析 openid（DB 查询，异步）
async function resolveOpenid(req: express.Request): Promise<string> {
  const token = resolveToken(req);
  if (!token) return '';
  return (await DB.resolveOpenidByToken(token)) || '';
}

// 微信官方接口专用 HTTPS 请求
// 云托管容器访问 api.weixin.qq.com 走内网网关，证书链不被 Node 认可
// （报错 self-signed certificate），故仅对该官方固定域名跳过证书验证。
function wxRequestJson(url: string, timeoutMs = 20000, opts?: { method?: string; headers?: Record<string,string>; body?: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    const send = (opts?.method || 'GET').toUpperCase() === 'POST'
      ? (cb: any) => {
          const r = https.request(url, { method: 'POST', rejectUnauthorized: false, timeout: timeoutMs, headers: opts?.headers || {} }, cb);
          if (opts?.body) r.write(opts.body);
          r.end();
          return r;
        }
      : (cb: any) => https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, cb);

    const req = send((res: any) => {
      let body = '';
      res.on('data', (chunk: any) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', (e: any) => reject(e));
  });
}

// ============================================================
// AI 供应商配置（DeepSeek 主 + Agnes 备）
// ============================================================
const AGNES_BASE_URL = () => env('AGNES_BASE_URL', 'https://apihub.agnes-ai.com/v1').replace(/\/+$/, '');
const AGNES_API_KEY = () => env('AGNES_API_KEY');
const AGNES_VISION_MODEL = () => env('AGNES_VISION_MODEL', 'agnes-2.5-flash');

const DEEPSEEK_API_KEY = () => env('DEEPSEEK_API_KEY');
const DEEPSEEK_BASE_URL = () => env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_CHAT_MODEL = () =>
  env('DEEPSEEK_CHAT_MODEL', env('DEEPSEEK_VISION_MODEL', 'deepseek-v4-flash'));

function agnesHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (AGNES_API_KEY()) headers['Authorization'] = `Bearer ${AGNES_API_KEY()}`;
  return headers;
}

// OpenAI 兼容请求封装：对 429 / 5xx 做指数退避重试（最多 3 次）；其余 4xx 快速失败
async function agnesFetch(apiPath: string, body: unknown, timeoutMs = 120000): Promise<any> {
  const url = `${AGNES_BASE_URL()}${apiPath}`;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: agnesHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok) return data;
      const err: any = new Error(`Agnes API ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
      // 4xx（除 429 限流）为确定性错误，不重试
      if (res.status !== 429 && res.status < 500) err.fatal = true;
      throw err;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error(`Agnes API 请求超时（${timeoutMs}ms）`);
      if (err?.fatal) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    // 指数退避后重试
    await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
  }
  throw lastErr || new Error('Agnes API 请求失败');
}

// DeepSeek 官方 API 请求封装（OpenAI 兼容 chat/completions，对 429/5xx 指数退避重试）
//
// maxAttempts: 最大尝试次数。识图走 DeepSeek 时传 1 ——
// 故障切换要求：DeepSeek 走不通时 15 秒内必须切 Agnes/快速失败，
// 所以故障切换路径上不重试（重试只会拖慢切换）。
async function deepseekFetch(body: unknown, timeoutMs = 180000, maxAttempts = 3): Promise<any> {
  const url = `${DEEPSEEK_BASE_URL()}/chat/completions`;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY()}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const content = data?.choices?.[0]?.message?.content || '';
        const finishReason = data?.choices?.[0]?.finish_reason || '';
        console.log('[deepseek] 返回内容长度:', content.length, 'finish_reason:', finishReason, '前 200 字符:', content.slice(0, 200));
        if (finishReason === 'length') {
          console.warn('[deepseek] 警告：输出被 max_tokens 截断，JSON 可能不完整，考虑调大 max_tokens');
        }
        return data;
      }
      const err: any = new Error(`DeepSeek API ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
      // 4xx（除 429 限流）为确定性错误，不重试
      if (res.status !== 429 && res.status < 500) err.fatal = true;
      throw err;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error(`DeepSeek API 请求超时（${timeoutMs}ms）`);
      if (err?.fatal) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    // 还有下一次尝试才退避等待；最后一次失败后直接抛，不多睡
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error('DeepSeek API 请求失败');
}

// 从模型输出中稳健提取 JSON（容忍 ```json 围栏与前后缀文本）
// 第 1 轮严格解析；失败后做常见 LLM 输出瑕疵修复再重试
function extractJson(raw: string, provider = 'unknown'): any {
  if (!raw) throw new Error('模型未返回内容');

  // 响应极短（<50字符）=> 模型返回异常，直接回退
  if (raw.trim().length < 50) {
    console.error(`[${provider}] 模型返回过短 (长度: ${raw.length}), 完整内容:`, JSON.stringify(raw.slice(0, 500)));
    throw new Error('模型返回内容异常过短');
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    console.error(`[${provider}] 未找到JSON, 原始输出前500字符:`, raw.slice(0, 500));
    throw new Error('模型输出中未找到 JSON');
  }
  let json = candidate.slice(start, end + 1);

  // 第 1 轮：直接解析
  try { return JSON.parse(json); } catch (e: any) { console.log(`[${provider}] 第1轮失败:`, e.message?.slice(0, 100)); }

  // 第 2 轮：修复常见的 LLM JSON 瑕疵
  try {
    const repaired = json
      .replace(/([}\]])"\s*/g, '$1, "')
      .replace(/(?<=[^\\])"\s*\n\s*(?=[^"]*":)/g, '\\n')
      .replace(/"\s+(?=")/g, '", ')
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/(\d)\s+"/g, '$1, "')
      .replace(/(true|false)\s+"/g, '$1, "');
    return JSON.parse(repaired);
  } catch (e: any) { console.log(`[${provider}] 第2轮失败:`, e.message?.slice(0, 100)); }

  // 第 3 轮：激进修复——清除所有换行制表符重建
  try {
    return JSON.parse(json.replace(/\n/g, ' ').replace(/\r/g, '').replace(/\t/g, ' '));
  } catch (e: any) { console.log(`[${provider}] 第3轮失败:`, e.message?.slice(0, 100)); }

  // 第 4 轮：尝试补全截断的 JSON（逐步裁剪末尾直到解析成功）
  for (let i = json.length - 1; i > start; i--) {
    const ch = json[i];
    if (ch === '}' || ch === ']') {
      try { return JSON.parse(json.slice(0, i + 1)); } catch (_) {}
    }
  }

  console.error(`[${provider}] extractJson 全部修复尝试失败，原始输出前 800 字符:`, json.slice(0, 800));
  throw new Error('无法解析模型输出的 JSON（已尝试 3 轮修复）');
}

// 统一为 data URI（若已是 data: 前缀则原样返回）
function toDataUri(imageBase64: string, mimeType?: string): string {
  return imageBase64.startsWith('data:')
    ? imageBase64
    : `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
}

/**
 * 识图调用（含 DeepSeek → Agnes 故障切换）。
 *
 * @param imageBase64 图片 Base64（可带 data URI 前缀）
 * @param promptText  提示词（建议与 response_format json_object 配合输出结构化 JSON）
 * @param opts.maxTokens 输出预算（默认 8192）
 * @returns 解析后的 JSON 对象
 *
 * 行为：
 *   1. DeepSeek：单次 15s 超时、不重试 → 超时/失败立即抛
 *   2. 失败后自动回退 Agnes（需配置 AGNES_API_KEY）
 *   3. 两者都失败时抛错，由调用方决定兜底
 */
export async function callVisionWithFailover(
  imageBase64: string,
  promptText: string,
  opts: { maxTokens?: number; provider?: string } = {}
): Promise<any> {
  const maxTokens = opts.maxTokens ?? 8192;
  const provider = opts.provider || 'meal';
  const parts = [
    { type: 'image_url', image_url: { url: toDataUri(imageBase64) } },
    { type: 'text', text: promptText },
  ];

  // 1) DeepSeek 主通道：15s 超时、单次不重试
  if (DEEPSEEK_API_KEY()) {
    try {
      const res = await deepseekFetch(
        {
          model: DEEPSEEK_CHAT_MODEL(),
          messages: [{ role: 'user', content: parts }],
          temperature: 1.0,
          max_tokens: maxTokens,
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
        },
        15000,
        1
      );
      const text = res?.choices?.[0]?.message?.content || '';
      if (!text) throw new Error('DeepSeek 识图未返回内容');
      return extractJson(text, `deepseek-${provider}`);
    } catch (err: any) {
      console.error(`[vision] DeepSeek 失败，回退 Agnes:`, err?.message);
    }
  }

  // 2) Agnes 降级通道
  if (AGNES_API_KEY()) {
    const res = await agnesFetch('/chat/completions', {
      model: AGNES_VISION_MODEL(),
      messages: [{ role: 'user', content: parts }],
      temperature: 1.0,
      max_tokens: maxTokens,
    });
    const text = res?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Agnes 识图未返回内容');
    return extractJson(text, `agnes-${provider}`);
  }

  throw new Error('AI 识图服务未配置（DEEPSEEK_API_KEY / AGNES_API_KEY 均为空）');
}

// ============================================================
// 路由
// ============================================================

async function startServer() {
  // 全局未捕获异常与 rejection 日志（避免静默崩溃）
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err?.message || err, err?.stack?.slice(0, 500));
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
  });

  await DB.initDB();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '25mb' }));

  // ============================================================
  // 全局限流（防 API Key 被刷爆）
  // ⚠️ 必须在**所有业务路由之前**挂载，否则限制不生效。
  // ============================================================
  app.use(RL.globalLimiter);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'meal-ai-nutritionist',
      deepseek: !!DEEPSEEK_API_KEY(),
      agnes: !!AGNES_API_KEY(),
    });
  });

  // ============================================================
  // 开发测试登录（用户名+密码，绕过微信 OAuth，仅用于开发调试）
  // ⚠️⚠️ 生产环境绝不配置 DEV_USER / DEV_PASS（等同于留后门）
  // ============================================================
  app.post('/api/auth/dev-login', async (req, res) => {
    const devUser = process.env.DEV_USER || '';
    const devPass = process.env.DEV_PASS || '';
    if (!devUser || !devPass) return res.status(404).json({ error: '测试登录未启用，请配置 DEV_USER / DEV_PASS 环境变量' });

    const { username, password } = req.body || {};
    if (username !== devUser || password !== devPass) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const testOpenid = 'dev_test_' + devUser;
    const user = await DB.getOrCreateUser(testOpenid, { nickName: devUser });
    const token = await DB.createToken(testOpenid);
    res.json({
      token,
      user: {
        nickName: user.nick_name,
        avatarUrl: user.avatar_url,
        phone: user.phone,
        openid: user.openid,
      },
    });
  });

  // 微信一键登录（wx.login code -> openid -> DB 自动注册/登录）
  // ============================================================
  app.post('/api/auth/login', RL.authLimiter, async (req, res) => {
    const { code, nickName, avatarUrl, phone } = req.body || {};
    if (!code) return res.status(400).json({ error: '缺少微信登录 code' });
    if (!WX_APPID() || !WX_SECRET()) {
      return res.status(500).json({ error: '服务端未配置 WX_APPID / WX_SECRET' });
    }

    try {
      const url =
        `https://api.weixin.qq.com/sns/jscode2session` +
        `?appid=${encodeURIComponent(WX_APPID())}` +
        `&secret=${encodeURIComponent(WX_SECRET())}` +
        `&js_code=${encodeURIComponent(code)}` +
        `&grant_type=authorization_code`;
      const data: any = await wxRequestJson(url);

      if (!data.openid) {
        return res.status(401).json({ error: `微信登录失败：${data.errcode || ''} ${data.errmsg || ''}` });
      }

      const openid: string = data.openid;

      // 保存 session_key —— 虚拟支付的用户态签名需要它
      if (data.session_key) {
        await DB.saveSessionKey(openid, data.session_key);
      }

      // DB：自动注册或更新登录时间
      const user = await DB.getOrCreateUser(openid, { nickName, avatarUrl });
      if (phone) await DB.updatePhone(openid, phone);

      // 签发登录令牌
      const token = await DB.createToken(openid);

      // 归一化字段名（DB snake_case → 前端 camelCase）
      res.json({
        token,
        user: {
          nickName: user.nick_name,
          avatarUrl: user.avatar_url,
          phone: user.phone,
          openid: user.openid,
        },
      });
    } catch (err: any) {
      const cause = err?.cause?.message || err?.cause?.code || '';
      console.error('微信登录错误:', err, '| cause:', cause);
      res.status(502).json({ error: `微信服务连接失败：${cause || err?.message || '未知'}` });
    }
  });

  // 当前登录用户信息
  app.get('/api/auth/me', async (req, res) => {
    const openid = await resolveOpenid(req);
    if (!openid) return res.status(401).json({ error: '未登录或登录已过期' });
    const user = await DB.getUser(openid);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    res.json({
      user: {
        nickName: user.nick_name,
        avatarUrl: user.avatar_url,
        phone: user.phone,
        openid: user.openid,
      },
      credits: await DB.calcCredits(openid),
    });
  });

  // ============================================================
  // W2：三餐 AI 营养师业务路由
  // ------------------------------------------------------------
  // 安全基线：全部需要登录（resolveOpenid → 401）；全局限流已在上方挂载；
  // /api/meal-analyze 额外挂 RL.llmCostLimiter + 额度校验/消耗（消耗 AI 配额）。
  // ============================================================

  async function requireOpenid(req: express.Request, res: express.Response): Promise<string | null> {
    const openid = await resolveOpenid(req);
    if (!openid) {
      res.status(401).json({ error: '未登录或登录已过期' });
      return null;
    }
    return openid;
  }

  // ---------- 用户画像 ----------

  // 保存画像（onboarding 用）。persona=glycemic 时必须 disclaimer_acknowledged=true。
  // 保存后用 Mifflin-St Jeor 公式计算每日目标热量区间一并返回。
  app.post('/api/user/profile', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const b = req.body || {};
      const persona: MEAL.Persona = b.persona === 'glycemic' ? 'glycemic' : 'takeout';
      if (persona === 'glycemic' && b.disclaimer_acknowledged !== true) {
        return res.status(400).json({ error: '控糖模式需先阅读并确认健康声明（disclaimer_acknowledged=true）' });
      }
      const num = (v: any) => (v === '' || v == null ? null : Number(v));
      const height_cm = num(b.height_cm);
      const weight_kg = num(b.weight_kg);
      const age = num(b.age);
      if (height_cm != null && (isNaN(height_cm) || height_cm < 100 || height_cm > 250)) {
        return res.status(400).json({ error: 'height_cm 非法（100-250）' });
      }
      if (weight_kg != null && (isNaN(weight_kg) || weight_kg < 30 || weight_kg > 300)) {
        return res.status(400).json({ error: 'weight_kg 非法（30-300）' });
      }
      if (age != null && (!Number.isInteger(age) || age < 10 || age > 120)) {
        return res.status(400).json({ error: 'age 非法（10-120 整数）' });
      }
      const gender: MEAL.Gender | null = b.gender === 'male' || b.gender === 'female' ? b.gender : null;
      const activity_level: MEAL.ActivityLevel = ['sedentary', 'light', 'moderate', 'active', 'very_active'].includes(b.activity_level)
        ? b.activity_level : 'light';

      const target = MEAL.calcTargetKcal({ height_cm, weight_kg, age, gender, activity_level });
      const profile = await DB.upsertUserProfile(openid, {
        persona, height_cm, weight_kg, age, gender, activity_level,
        daily_kcal_low: target?.low ?? null,
        daily_kcal_high: target?.high ?? null,
        disclaimer_acknowledged: !!b.disclaimer_acknowledged,
      });
      res.json({
        profile,
        target_detail: target ? { bmr: target.bmr, tdee: target.tdee } : null,
      });
    } catch (err: any) {
      console.error('[user/profile]', err?.message);
      res.status(500).json({ error: '保存画像失败，请稍后再试' });
    }
  });

  // 读取画像
  app.get('/api/user/profile', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const profile = await DB.getUserProfile(openid);
      res.json({ profile });
    } catch (err: any) {
      console.error('[user/profile GET]', err?.message);
      res.status(500).json({ error: '读取画像失败，请稍后再试' });
    }
  });

  // ---------- 餐食分析（只分析不落库，落库走 /api/diet-log） ----------

  app.post('/api/meal-analyze', RL.llmCostLimiter, async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const b = req.body || {};
      const persona: MEAL.Persona = b.persona === 'glycemic' ? 'glycemic' : 'takeout';
      const image = String(b.image || '');
      if (!image) return res.status(400).json({ error: '缺少 image（data URI / Base64 / 图片 URL）' });

      // 额度校验（安全基线：消耗 AI 配额的接口必须校验额度）
      const before = await DB.calcCredits(openid);
      if (!before.totalRemaining) {
        return res.status(402).json({ error: 'quota_exhausted', credits: before });
      }

      // 图片输入归一化为 data URI
      let dataUri: string;
      if (image.startsWith('data:')) {
        dataUri = image;
      } else if (/^https?:\/\//i.test(image)) {
        const dl = await MEAL.fetchImageToBase64(image);
        dataUri = `data:${dl.mime};base64,${dl.base64}`;
      } else if (/^[A-Za-z0-9+/=\s]+$/.test(image) && image.replace(/\s/g, '').length > 100) {
        dataUri = image; // 裸 Base64（callVisionWithFailover 内补 data URI 前缀）
      } else {
        return res.status(400).json({ error: 'image 格式不支持（需要 data URI / Base64 / http(s) URL）' });
      }

      const prompt = MEAL.loadPersonaPrompt(persona);
      const analysis = await callVisionWithFailover(dataUri, prompt, { provider: 'meal' });

      // 与测试脚本同款校验
      const vErrs = MEAL.validateMealAnalysis(analysis, persona);
      if (vErrs.length > 0) {
        return res.status(502).json({ error: '分析结果校验失败', validation_errors: vErrs });
      }

      // 服务端用药行为安全复查：命中则截断 suggestion 并打标记
      let med_safety_hit = false;
      if (MEAL.medSafetyHit(analysis)) {
        med_safety_hit = true;
        analysis.suggestion = '该条建议涉及用药相关内容，已被安全策略截断。如有疑问请咨询医生或药师。';
        console.warn(`[med-safety] user=${openid.slice(0, 8)} persona=${persona} 命中用药行为词表，已截断 suggestion`);
      }

      // 分析成功后消耗一次额度
      const consume = await DB.consumeCredit(openid);
      if (!consume.ok) {
        return res.status(402).json({ error: 'quota_exhausted', credits: consume.credits });
      }

      res.json({ analysis, med_safety_hit, credits: consume.credits });
    } catch (err: any) {
      console.error('[meal-analyze]', err?.message);
      res.status(502).json({ error: `餐食分析失败：${err?.message || '未知错误'}` });
    }
  });

  // ---------- 饮食记录 ----------

  // 落库一条饮食记录（客户端可先让用户手动修正 analysis 再提交）
  app.post('/api/diet-log', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const b = req.body || {};
      const { log_date, meal_type, persona, analysis } = b;
      if (!MEAL.isValidDate(log_date)) return res.status(400).json({ error: 'log_date 非法（YYYY-MM-DD）' });
      if (!MEAL.MEAL_TYPES.includes(meal_type)) {
        return res.status(400).json({ error: 'meal_type 非法（breakfast|lunch|dinner|snack）' });
      }
      const p: MEAL.Persona = persona === 'glycemic' ? 'glycemic' : 'takeout';
      if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.dishes)) {
        return res.status(400).json({ error: 'analysis 非法（需要 /api/meal-analyze 返回的 JSON）' });
      }

      // 区间求和：各菜品区间相加得到整餐区间
      const sumRange = (key: string) => {
        let lo = 0, hi = 0, any = false;
        for (const d of analysis.dishes) {
          const r = MEAL.parseRange(d[key]);
          if (r) { lo += r.low; hi += r.high; any = true; }
        }
        return any ? { low: lo, high: hi } : { low: null as number | null, high: null as number | null };
      };
      const kcal = sumRange('kcal_range');
      const protein = sumRange('protein_g');
      const carb = sumRange('carb_g');
      const fat = sumRange('fat_g');
      const fiber = sumRange('fiber_g');
      const meal_score = Number.isInteger(analysis.meal_score) ? analysis.meal_score : null;

      const id = await DB.insertDietLog(openid, {
        log_date, meal_type, persona,
        image_url: typeof b.image_url === 'string' ? b.image_url : '',
        dishes: analysis.dishes,
        kcal_low: kcal.low, kcal_high: kcal.high,
        protein_low: protein.low, protein_high: protein.high,
        carb_low: carb.low, carb_high: carb.high,
        fat_low: fat.low, fat_high: fat.high,
        fiber_low: fiber.low, fiber_high: fiber.high,
        meal_score,
        suggestion: typeof analysis.suggestion === 'string' ? analysis.suggestion : null,
        glycemic_risk: p === 'glycemic' && typeof analysis.glycemic_risk === 'string' ? analysis.glycemic_risk : null,
      });
      res.json({ id, log_date, meal_type });
    } catch (err: any) {
      console.error('[diet-log POST]', err?.message);
      res.status(500).json({ error: '保存饮食记录失败，请稍后再试' });
    }
  });

  // 按日查询：当日记录 + 汇总 + 三餐齐全度 + 目标对比
  app.get('/api/diet-log', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const date = typeof req.query.date === 'string' && MEAL.isValidDate(req.query.date)
        ? req.query.date : MEAL.shanghaiDate();
      const logs = await DB.getDietLogsByDate(openid, date);
      const sum = (k: string) => logs.reduce((a: number, l: any) => a + (l[k] ?? 0), 0);
      const total = {
        kcal_low: sum('kcal_low'), kcal_high: sum('kcal_high'),
        protein_low: sum('protein_low'), protein_high: sum('protein_high'),
        carb_low: sum('carb_low'), carb_high: sum('carb_high'),
        fat_low: sum('fat_low'), fat_high: sum('fat_high'),
        fiber_low: sum('fiber_low'), fiber_high: sum('fiber_high'),
      };
      const meals_present = {
        breakfast: logs.some((l: any) => l.meal_type === 'breakfast'),
        lunch: logs.some((l: any) => l.meal_type === 'lunch'),
        dinner: logs.some((l: any) => l.meal_type === 'dinner'),
      };
      const profile = await DB.getUserProfile(openid);
      res.json({
        date,
        logs,
        total,
        meals_present,
        target: profile
          ? { daily_kcal_low: profile.daily_kcal_low, daily_kcal_high: profile.daily_kcal_high }
          : null,
      });
    } catch (err: any) {
      console.error('[diet-log GET]', err?.message);
      res.status(500).json({ error: '读取饮食记录失败，请稍后再试' });
    }
  });

  // ---------- 体重记录 ----------

  // 记录体重（同一天重复则覆盖）
  app.post('/api/weight-log', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      const { log_date, weight_kg } = req.body || {};
      if (!MEAL.isValidDate(log_date)) return res.status(400).json({ error: 'log_date 非法（YYYY-MM-DD）' });
      const w = Number(weight_kg);
      if (isNaN(w) || w < 20 || w > 300) return res.status(400).json({ error: 'weight_kg 非法（20-300）' });
      const rounded = Math.round(w * 10) / 10;
      await DB.upsertWeightLog(openid, log_date, rounded);
      res.json({ log_date, weight_kg: rounded });
    } catch (err: any) {
      console.error('[weight-log POST]', err?.message);
      res.status(500).json({ error: '保存体重失败，请稍后再试' });
    }
  });

  // 体重曲线数据点（按日期升序，默认最近 30 天）
  app.get('/api/weight-log', async (req, res) => {
    const openid = await requireOpenid(req, res);
    if (!openid) return;
    try {
      let days = parseInt(String(req.query.days || '30'), 10);
      if (isNaN(days) || days < 1) days = 30;
      if (days > 365) days = 365;
      const points = await DB.getWeightLogs(openid, days);
      res.json({ days, points });
    } catch (err: any) {
      console.error('[weight-log GET]', err?.message);
      res.status(500).json({ error: '读取体重记录失败，请稍后再试' });
    }
  });

  // ============================================================
  // 虚拟支付路由（会员/次数包）：参考 vibeshot 的 /api/virtual-pay/* 实现
  //
  // ⚠️ 新增消耗 AI 额度的接口必须同时满足：
  //     1. 登录校验（resolveOpenid → 401）
  //     2. RL.llmCostLimiter 限流
  //     3. 额度校验（DB.calcCredits → 402 quota_exhausted）
  // ============================================================

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  // 统一错误处理（避免异常堆栈泄露给客户端）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[ERROR]', req.method, req.path, err?.message || err);
    res.status(500).json({ error: '服务异常，请稍后再试' });
  });

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[三餐AI营养师] Server running on http://localhost:${PORT}`);
    if (DEEPSEEK_API_KEY()) {
      console.log(`[三餐AI营养师] DeepSeek: 模型=${DEEPSEEK_CHAT_MODEL()} 端点=${DEEPSEEK_BASE_URL()}`);
    } else {
      console.warn('[三餐AI营养师] DEEPSEEK_API_KEY 未配置，识图将走 Agnes 降级通道');
    }
    if (!AGNES_API_KEY()) {
      console.warn('[三餐AI营养师] AGNES_API_KEY 未配置，DeepSeek 失败时无降级通道');
    }
  });
}

startServer().catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
