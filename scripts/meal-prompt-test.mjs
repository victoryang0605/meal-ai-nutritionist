#!/usr/bin/env node
/**
 * meal-prompt-test.mjs —— 三餐 AI 营养师 W1 prompt 原型测试脚本
 *
 * 照抄 ~/workspace/vibeshot/server.ts 的 DeepSeek vision 调用格式：
 *   POST {DEEPSEEK_BASE_URL}/chat/completions
 *   body: { model, messages:[{role:'user',content:[{type:'image_url',...},{type:'text',...}]}],
 *           temperature:1.0, max_tokens:8192, thinking:{type:'disabled'},
 *           response_format:{type:'json_object'} }
 *   单次 15s 超时、不重试（maxAttempts=1）。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/meal-prompt-test.mjs \
 *     --images ~/workspace/meal-ai-nutritionist/test-images \
 *     --prompt ~/workspace/meal-ai-nutritionist/prompts/meal-analyze.md \
 *     [--out ~/workspace/meal-ai-nutritionist/test-report] \
 *     [--personas takeout,glycemic] [--delay-ms 800]
 *
 * 输出：<out>/raw.jsonl（每行一次调用的原始结果）+ <out>/report.md（人类可读摘要）
 * 任何单次失败（超时/HTTP错/JSON解析失败）只记录、不中断。
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// ---------- 参数 ----------
const args = process.argv.slice(2);
const opt = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const IMAGES_DIR = opt('--images');
const PROMPT_FILE = opt('--prompt');
const OUT_DIR = opt('--out', join(process.env.HOME || '/root', 'workspace/meal-ai-nutritionist/test-report'));
const PERSONAS = opt('--personas', 'takeout,glycemic').split(',').map((s) => s.trim()).filter(Boolean);
const DELAY_MS = Number(opt('--delay-ms', '800')) || 0;

if (!IMAGES_DIR || !PROMPT_FILE) {
  console.error('用法：node scripts/meal-prompt-test.mjs --images <图片目录> --prompt <prompt md> [--out <输出目录>]');
  process.exit(2);
}

// ---------- 环境 ----------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
if (!DEEPSEEK_API_KEY) {
  console.error('[meal-prompt-test] 未设置 DEEPSEEK_API_KEY，无法调用 API。');
  console.error('  请先 export DEEPSEEK_API_KEY=sk-xxx 后再运行（不要把 key 写进文件）。');
  process.exit(2);
}
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEEPSEEK_MODEL = process.env.DEEPSEEK_CHAT_MODEL || process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash';
const TIMEOUT_MS = 15000;

// ---------- prompt 切分（按 <!-- PERSONA:xxx --> 标记） ----------
const md = readFileSync(PROMPT_FILE, 'utf8');
function extractPersona(name) {
  // 按独占一行的 <!-- PERSONA:name --> 标记切分（避免正文里提及标记名造成误匹配）
  const lines = md.split('\n');
  const marker = `<!-- PERSONA:${name} -->`;
  const si = lines.findIndex((l) => l.trim() === marker);
  if (si < 0) throw new Error(`prompt 文件中找不到 PERSONA:${name} 标记`);
  let ei = lines.findIndex((l, i) => i > si && /^<!--\s*PERSONA:/.test(l.trim()));
  if (ei < 0) ei = lines.length;
  // 附带统一 Schema 说明（标记之后的部分），让模型看得到 schema
  const schemaIdx = md.indexOf('## 统一 JSON Schema');
  const schema = schemaIdx >= 0 ? md.slice(schemaIdx) : '';
  return lines.slice(si + 1, ei).join('\n').trim() + '\n\n' + schema;
}
const prompts = {};
for (const p of PERSONAS) prompts[p] = extractPersona(p);

// ---------- 小工具 ----------
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractJson(raw) {
  // 容忍 ```json 围栏与前后缀文本：取首个 { 到末个 } 之间
  const t = String(raw || '').replace(/```json|```/g, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(t.slice(s, e + 1));
}

const RANGE_RE = /^\d+\s*-\s*\d+$/;
function validateParsed(p, persona) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['输出不是 JSON 对象'];
  if (!Array.isArray(p.dishes)) errs.push('缺少 dishes 数组');
  for (const d of p.dishes || []) {
    if (!RANGE_RE.test(String(d.kcal_range || ''))) errs.push(`菜品[${d.name}] kcal_range 不是区间: ${d.kcal_range}`);
    if (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1) errs.push(`菜品[${d.name}] confidence 非法: ${d.confidence}`);
  }
  if (p.meal_score != null && (!Number.isInteger(p.meal_score) || p.meal_score < 0 || p.meal_score > 100))
    errs.push(`meal_score 非法: ${p.meal_score}`);
  if (persona === 'takeout' && (p.glycemic_risk != null || p.gi_notes != null || p.meal_order_tip != null))
    errs.push('画像A 不应输出控糖字段');
  const medRe = /二甲双胍|格列|阿卡波糖|列净|列汀|调药|停药|加药|减药|胰岛素.{0,8}(剂量|用法|注射|怎么打|打多少)|吃了药就|可以放开吃|评价药效/;
  if (medRe.test(JSON.stringify(p))) errs.push('医疗安全失败：输出含用药行为建议');
  return errs;
}

// ---------- 单次调用（照抄 server.ts deepseekFetch：15s 超时、1 次尝试、4xx(除429) fatal） ----------
async function callVision(imagePath, promptText) {
  const ext = extname(imagePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片格式: ${ext}`);
  const b64 = readFileSync(imagePath).toString('base64');
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          { type: 'text', text: promptText },
        ],
      },
    ],
    temperature: 1.0,
    max_tokens: 8192,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`DeepSeek API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      err.fatal = res.status !== 429 && res.status < 500;
      throw err;
    }
    const content = data?.choices?.[0]?.message?.content || '';
    const finishReason = data?.choices?.[0]?.finish_reason || '';
    if (finishReason === 'length') console.warn(`[warn] ${basename(imagePath)} 输出被 max_tokens 截断`);
    return { content, finishReason, ms: Date.now() - t0 };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`DeepSeek API 请求超时（${TIMEOUT_MS}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 主流程 ----------
const files = readdirSync(IMAGES_DIR)
  .filter((f) => MIME[extname(f).toLowerCase()])
  .sort()
  .map((f) => join(IMAGES_DIR, f))
  .filter((p) => statSync(p).isFile());

if (!files.length) {
  console.error(`[meal-prompt-test] 图片目录无可用图片: ${IMAGES_DIR}`);
  process.exit(2);
}
console.log(`[meal-prompt-test] 模型=${DEEPSEEK_MODEL} 图片=${files.length} 画像=${PERSONAS.join(',')}`);

mkdirSync(OUT_DIR, { recursive: true });
const results = [];

for (const img of files) {
  for (const persona of PERSONAS) {
    const name = `${basename(img)} / ${persona}`;
    console.log(`→ ${name}`);
    const rec = { file: basename(img), persona, ok: false, ms: null, finish_reason: null, parsed: null, validation_errors: [], error: null };
    try {
      const { content, finishReason, ms } = await callVision(img, prompts[persona]);
      rec.ms = ms;
      rec.finish_reason = finishReason;
      try {
        rec.parsed = extractJson(content);
        rec.validation_errors = validateParsed(rec.parsed, persona);
        rec.ok = rec.validation_errors.length === 0;
      } catch (e) {
        rec.error = `JSON 解析失败: ${e.message}；原始前200字符: ${content.slice(0, 200)}`;
      }
    } catch (e) {
      rec.error = e.message;
    }
    results.push(rec);
    if (DELAY_MS) await sleep(DELAY_MS);
  }
}

// ---------- 写 raw.jsonl ----------
writeFileSync(join(OUT_DIR, 'raw.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---------- 写 report.md ----------
function kcalTotal(dishes) {
  let lo = 0, hi = 0, ok = true;
  for (const d of dishes || []) {
    const m = String(d.kcal_range || '').match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) { ok = false; break; }
    lo += Number(m[1]); hi += Number(m[2]);
  }
  return ok && dishes?.length ? `${lo}-${hi} kcal` : '—';
}
const L = [];
L.push(`# 三餐 AI 营养师 · W1 Prompt 原型测试报告`);
L.push(``);
L.push(`- 时间：${new Date().toISOString()}`);
L.push(`- 模型：${DEEPSEEK_MODEL}`);
L.push(`- 画像：${PERSONAS.join(', ')}`);
L.push(`- 图片数：${files.length}，总调用：${results.length}，成功：${results.filter((r) => r.ok).length}，失败：${results.filter((r) => !r.ok).length}`);
L.push(``);
L.push(`| 图片 | 画像 | 结果 | 耗时ms | 评分 | 菜品数 | 热量合计(区间) | 校验问题 |`);
L.push(`|---|---|---|---|---|---|---|---|`);
for (const r of results) {
  const p = r.parsed || {};
  L.push(`| ${r.file} | ${r.persona} | ${r.ok ? '✅' : '❌'} | ${r.ms ?? '—'} | ${p.meal_score ?? '—'} | ${(p.dishes || []).length} | ${kcalTotal(p.dishes)} | ${(r.validation_errors || []).join('; ') || r.error || ''} |`);
}
L.push(``);
for (const r of results) {
  const p = r.parsed;
  L.push(`## ${r.file} · ${r.persona} ${r.ok ? '✅' : '❌'}`);
  if (!p) { L.push(``); L.push(`> 失败：${r.error}`); L.push(``); continue; }
  L.push(``);
  L.push(`- 图片类型：${p.image_type || '—'}${p.image_note ? `（${p.image_note}）` : ''}`);
  L.push(`- 综合评分：${p.meal_score ?? '—'}`);
  for (const d of p.dishes || []) {
    L.push(`- ${d.name}：${d.kcal_range} kcal（蛋白${d.protein_g}g/碳水${d.carb_g}g/脂肪${d.fat_g}g/纤维${d.fiber_g}g，置信度${d.confidence}）`);
  }
  if (p.highlights?.length) L.push(`- 亮点：${p.highlights.join('；')}`);
  if (p.warnings?.length) L.push(`- 风险：${p.warnings.join('；')}`);
  if (p.suggestion) L.push(`- 建议：${p.suggestion}`);
  if (r.persona === 'glycemic') {
    if (p.glycemic_risk) L.push(`- 升糖风险：${p.glycemic_risk}`);
    if (p.gi_notes) L.push(`- GI说明：${p.gi_notes}`);
    if (p.meal_order_tip) L.push(`- 进餐顺序：${p.meal_order_tip}`);
  }
  if (p.refusal) L.push(`- ⚠️ 拒答：${p.refusal}`);
  if (r.validation_errors?.length) L.push(`- ⚠️ 校验问题：${r.validation_errors.join('; ')}`);
  if (r.error) L.push(`- ⚠️ 错误：${r.error}`);
  L.push(``);
}
writeFileSync(join(OUT_DIR, 'report.md'), L.join('\n'));
console.log(`[meal-prompt-test] 完成：${results.filter((r) => r.ok).length}/${results.length} 成功，报告见 ${OUT_DIR}/`);
