/**
 * meal.ts — 三餐 AI 营养师业务逻辑模块
 *
 * 内容：
 *   1. 双画像 prompt 加载与切分（逻辑照抄 scripts/meal-prompt-test.mjs 的 extractPersona）
 *   2. 模型输出校验（与测试脚本同款规则：区间正则、meal_score、画像A禁控糖字段、用药行为词表）
 *   3. 服务端用药行为安全复查（prompt 已放宽：只禁推荐具体药物/调加减停药/胰岛素剂量用法指导/评价药效）
 *   4. Mifflin-St Jeor 每日目标热量区间计算
 *   5. 图片 URL 下载转 Base64（meal-analyze 支持传 URL）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type Persona = 'takeout' | 'glycemic';
export const PERSONAS: Persona[] = ['takeout', 'glycemic'];

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

// ============================================================
// 1. Prompt 加载与切分
// ============================================================

let promptCache: string | null = null;

function loadPromptFile(): string {
  if (promptCache !== null) return promptCache;
  const candidates = [
    path.join(process.cwd(), 'scripts/prompts/meal-analyze.md'),
    path.join(__dirname, 'scripts/prompts/meal-analyze.md'),
    path.join(__dirname, '..', 'scripts/prompts/meal-analyze.md'), // dist/server.mjs -> 仓库根
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      promptCache = fs.readFileSync(p, 'utf-8');
      return promptCache;
    }
  }
  throw new Error('找不到 prompt 文件 scripts/prompts/meal-analyze.md');
}

/**
 * 按独占一行的 <!-- PERSONA:name --> 标记切分，并附带文末统一 JSON Schema。
 * 与 scripts/meal-prompt-test.mjs 的 extractPersona 逻辑一致。
 */
export function loadPersonaPrompt(name: Persona): string {
  const md = loadPromptFile();
  const lines = md.split('\n');
  const marker = `<!-- PERSONA:${name} -->`;
  const si = lines.findIndex((l) => l.trim() === marker);
  if (si < 0) throw new Error(`prompt 文件中找不到 PERSONA:${name} 标记`);
  let ei = lines.findIndex((l, i) => i > si && /^<!--\s*PERSONA:/.test(l.trim()));
  if (ei < 0) ei = lines.length;
  const schemaIdx = md.indexOf('## 统一 JSON Schema');
  const schema = schemaIdx >= 0 ? md.slice(schemaIdx) : '';
  return lines.slice(si + 1, ei).join('\n').trim() + '\n\n' + schema;
}

// ============================================================
// 2. 区间解析与模型输出校验
// ============================================================

const RANGE_RE = /^(\d+)\s*-\s*(\d+)$/;

/** 解析 "550-700" -> { low: 550, high: 700 }；解析失败返回 null */
export function parseRange(s: unknown): { low: number; high: number } | null {
  const m = RANGE_RE.exec(String(s ?? '').trim());
  if (!m) return null;
  const low = parseInt(m[1], 10);
  const high = parseInt(m[2], 10);
  if (high < low) return { low: high, high: low };
  return { low, high };
}

// 用药行为词表（已放宽：只禁推荐具体药物/调加减停药/胰岛素剂量用法指导/评价药效，
// 生理科普如"胰岛素敏感性"放行）。与 scripts/meal-prompt-test.mjs 保持一致。
const MED_BEHAVIOR_RE =
  /二甲双胍|格列|阿卡波糖|列净|列汀|调药|停药|加药|减药|胰岛素.{0,8}(剂量|用法|注射|怎么打|打多少)|吃了药就|可以放开吃|评价药效/;

/** 服务端用药行为安全复查：对输出全文跑词表，命中返回 true */
export function medSafetyHit(obj: unknown): boolean {
  try {
    return MED_BEHAVIOR_RE.test(JSON.stringify(obj));
  } catch {
    return false;
  }
}

/**
 * 模型输出校验（与测试脚本同款规则）。
 * 返回错误列表；空数组表示通过。
 */
export function validateMealAnalysis(p: any, persona: Persona): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== 'object') return ['输出不是 JSON 对象'];
  // 拒答是合法输出，直接通过
  if (p.refusal) return errs;
  if (!Array.isArray(p.dishes)) errs.push('缺少 dishes 数组');
  for (const d of p.dishes || []) {
    if (!RANGE_RE.test(String(d.kcal_range || ''))) errs.push(`菜品[${d.name}] kcal_range 不是区间: ${d.kcal_range}`);
    const c = d.confidence;
    if (typeof c !== 'number' || c < 0 || c > 1) errs.push(`菜品[${d.name}] confidence 非法: ${c}`);
  }
  const ms = p.meal_score;
  if (ms != null && (!Number.isInteger(ms) || ms < 0 || ms > 100)) errs.push(`meal_score 非法: ${ms}`);
  if (persona === 'takeout' && (p.glycemic_risk != null || p.gi_notes != null || p.meal_order_tip != null)) {
    errs.push('画像A 不应输出控糖字段');
  }
  if (medSafetyHit(p)) errs.push('医疗安全失败：输出含用药行为建议');
  return errs;
}

// ============================================================
// 3. Mifflin-St Jeor 每日目标热量区间
// ============================================================

export type Gender = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,    // 久坐
  light: 1.375,      // 轻度活动
  moderate: 1.55,    // 中度活动
  active: 1.725,     // 高强度活动
  very_active: 1.9,  // 极高强度
};

/**
 * Mifflin-St Jeor 公式算每日目标热量区间（按画像给缺口）。
 *   BMR(男) = 10×体重kg + 6.25×身高cm − 5×年龄 + 5
 *   BMR(女) = 10×体重kg + 6.25×身高cm − 5×年龄 − 161
 *   TDEE = BMR × 活动系数
 *
 * 缺口规则（2026-10-15 定）：
 *   - 减脂画像（takeout）：每日 300–500 kcal 缺口，即 [max(BMR, TDEE−500), TDEE−300]。
 *     依据：300–500 kcal/天是体重管理中的常用安全缺口（约 7700 kcal ≈ 1kg 脂肪，
 *     对应每周约 0.3–0.5kg）；下限不低于 BMR 是非医疗监督下的安全红线。
 *   - 控糖画像（glycemic）：最多 200 kcal 温和缺口，即 [max(BMR, TDEE−200), TDEE]。
 *     依据：控糖的核心价值是碳水质量与进餐顺序，不是热量缺口；降糖药 + 大缺口
 *     有低血糖风险，产品绝不能诱导。如需减重目标请咨询医生。
 *   - 保护性规则（双画像通用）：未成年人（age < 18）或 BMI < 18.5 只给维持区间
 *     [max(BMR, 0.95×TDEE), TDEE]，不给任何缺口。
 * 缺任一输入返回 null。
 */
export function calcTargetKcal(input: {
  height_cm?: number | null;
  weight_kg?: number | null;
  age?: number | null;
  gender?: Gender | null;
  activity_level?: ActivityLevel | null;
  persona?: Persona | null;
}): { low: number; high: number; bmr: number; tdee: number; note: string } | null {
  const { height_cm, weight_kg, age, gender, activity_level, persona } = input;
  if (
    height_cm == null || weight_kg == null || age == null || !gender ||
    height_cm <= 0 || weight_kg <= 0 || age <= 0
  ) {
    return null;
  }
  const bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (gender === 'male' ? 5 : -161);
  const factor = ACTIVITY_FACTOR[activity_level || 'light'] || ACTIVITY_FACTOR.light;
  const tdee = bmr * factor;
  const bmi = weight_kg / Math.pow(height_cm / 100, 2);

  let low: number;
  let high: number;
  let note: string;
  if (age < 18 || bmi < 18.5) {
    // 保护性：未成年人或偏瘦只给维持区间
    low = Math.round(Math.max(bmr, tdee * 0.95));
    high = Math.round(tdee);
    note = '当前按维持热量设定目标，不建议主动制造热量缺口';
  } else if (persona === 'glycemic') {
    low = Math.round(Math.max(bmr, tdee - 200));
    high = Math.round(tdee);
    note = '控糖目标以维持热量为基准，重点管理升糖负荷与进餐顺序；如需减重请咨询医生';
  } else {
    low = Math.round(Math.max(bmr, tdee - 500));
    high = Math.round(tdee - 300);
    note = '每日 300–500 kcal 缺口，预计每周减重约 0.3–0.5kg';
  }
  // 极端小体型时 low 可能超过 high，收敛为单点
  if (low > high) low = high;
  return { low, high, bmr: Math.round(bmr), tdee: Math.round(tdee), note };
}

// ============================================================
// 4. 图片 URL 下载转 Base64
// ============================================================

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 下载 http(s) 图片并转 Base64（15s 超时，10MB 上限，仅接受 image/*） */
export async function fetchImageToBase64(url: string): Promise<{ base64: string; mime: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) 图片 URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/')) throw new Error(`URL 不是图片：${contentType}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('图片内容为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB 上限');
    return { base64: buf.toString('base64'), mime: contentType || 'image/jpeg' };
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('图片下载超时（15s）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 上海日期 YYYY-MM-DD（默认 log_date 用） */
export function shanghaiDate(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 校验 YYYY-MM-DD 且为真实日期 */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
