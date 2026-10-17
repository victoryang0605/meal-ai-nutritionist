// utils/api.js —— 后端接口集中封装
// ============================================================
// 所有后端 snake_case → 前端 camelCase 的转换只在这一个文件里做，
// 页面代码只用 camelCase。以后后端改字段，只改这里。
//
// 后端地址：Victor 部署后填真实域名（HTTPS，需加到小程序 request 合法域名）。
// 联调时可临时改为局域网地址，真机需与电脑同一 WiFi。
// ============================================================
const API_BASE = 'https://api.cooperelate.com';

const TOKEN_KEY = 'meal_token';
const PROFILE_KEY = 'meal_profile_cache';
const CHECKIN_DAYS_KEY = 'meal_checkin_days'; // 本地打卡日期（YYYY-MM-DD 数组）
const CREDITS_KEY = 'meal_credits';           // 最近一次后端返回的额度快照

// 每日打卡提醒订阅消息模板 ID。
// 订阅消息模板 ID（Victor 已在小程序后台申请到「打卡提醒」类模板）。
// 后端 data 字段组装若与模板实际字段不匹配，按模板详情页调整（见 server.ts TODO）。
const REMINDER_TEMPLATE_ID = 'VSZc_UxOev7TohuwK1Ro18uGcmFGPCso08vpOGolSIQ';

// ---------- 基础 ----------

function getToken() {
return wx.getStorageSync(TOKEN_KEY) || '';
}

function authHeader() {
const t = getToken();
return t? { 'Authorization': 'Bearer ' + t}: {};
}

function request(path, { method = 'GET', data = null, needAuth = true} = {}, _retried = false) {
return new Promise((resolve) => {
wx.request({
url: API_BASE + path,
method,
data: data || {},
header: Object.assign({ 'content-type': 'application/json'}, needAuth? authHeader(): {}),
timeout: 60000,
success: (res) => {
// 401 → 自动 wx.login 换 token 后重试一次
if (res.statusCode === 401 && needAuth &&!_retried) {
wxLogin().then((ok) => {
if (ok) resolve(request(path, { method, data, needAuth}, true));
else resolve({ ok: false, status: 401, data: null});
});
return;
}
resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: res.data});
},
fail: (err) => resolve({ ok: false, status: 0, data: null, err})
});
});
}

// ---------- 登录 ----------

// wx.login → 后端换 token。成功返回 true。
// nickName/avatarUrl：在 onboarding 建档时传入（type="nickname" 输入 + chooseAvatar）。
function wxLogin(nickName, avatarUrl) {
return new Promise((resolve) => {
wx.login({
success: (lr) => {
if (!lr.code) { resolve(false); return;}
wx.request({
url: API_BASE + '/api/auth/login',
method: 'POST',
data: { code: lr.code, nickName: nickName || undefined, avatarUrl: avatarUrl || undefined},
header: { 'content-type': 'application/json'},
timeout: 30000,
success: (res) => {
if (res.statusCode === 200 && res.data && res.data.token) {
wx.setStorageSync(TOKEN_KEY, res.data.token);
const app = getApp();
app.globalData.token = res.data.token;
app.globalData.user = res.data.user || null;
resolve(true);
} else {
wx.showToast({ title: (res.data && res.data.error) || '登录失败', icon: 'none'});
resolve(false);
}
},
fail: () => { wx.showToast({ title: '网络异常，登录失败', icon: 'none'}); resolve(false);}
});
},
fail: () => resolve(false)
});
});
}

// 确保已登录（无 token 时自动登录）
async function ensureLogin() {
  if (getToken()) return true;
  return wxLogin();
}

// 是否已有登录态（有 token 即认为登录过，用于判断新老用户分流）
function hasSession() {
  return !!getToken();
}

// 只读本地画像缓存，不发网络请求。用于登录页快速判断新老用户。
function getCachedProfile() {
  const app = getApp();
  if (app && app.globalData && app.globalData.profile) return app.globalData.profile;
  const cached = wx.getStorageSync(PROFILE_KEY);
  return cached && cached.persona ? cached : null;
}

function logout() {
wx.removeStorageSync(TOKEN_KEY);
wx.removeStorageSync(PROFILE_KEY);
const app = getApp();
app.globalData.token = '';
app.globalData.user = null;
app.globalData.profile = null;
}

// ---------- 字段映射（snake_case → camelCase，只在这里做） ----------

function mapProfile(p) {
if (!p) return null;
return {
persona: p.persona || 'takeout',
heightCm: p.height_cm?? null,
weightKg: p.weight_kg?? null,
age: p.age?? null,
gender: p.gender || null, // male | female
activityLevel: p.activity_level || 'light',
dailyKcalLow: p.daily_kcal_low?? null,
dailyKcalHigh: p.daily_kcal_high?? null,
disclaimerAck:!!p.disclaimer_acknowledged,
};
}

function mapDish(d) {
return {
name: d.name || '未知菜品',
portion: d.portion_g_est || '',
kcalRange: d.kcal_range || '',
protein: d.protein_g || '',
carb: d.carb_g || '',
fat: d.fat_g || '',
fiber: d.fiber_g || '',
confidence: typeof d.confidence === 'number'? d.confidence: null,
// 置信度低于 0.6 标"估算"
isEstimate: typeof d.confidence === 'number'? d.confidence < 0.6: false,
};
}

function mapAnalysis(a) {
if (!a) return null;
return {
persona: a.persona || 'takeout',
dishes: (a.dishes || []).map(mapDish),
mealScore: a.meal_score?? null,
highlights: a.highlights || [],
warnings: a.warnings || [],
suggestion: a.suggestion || '',
glycemicRisk: a.glycemic_risk || null, // 高 | 中 | 低
giNotes: a.gi_notes || '',
mealOrderTip: a.meal_order_tip || '',
imageType: a.image_type || '',
imageNote: a.image_note || '',
_raw: a, // 落库时原样提交
};
}

function mapDietLog(l) {
if (!l) return null;
return {
id: l.id,
date: l.log_date || '',
mealType: l.meal_type || '',
persona: l.persona || 'takeout',
dishes: (l.dishes || []).map(mapDish),
kcalLow: l.kcal_low?? 0,
kcalHigh: l.kcal_high?? 0,
mealScore: l.meal_score?? null,
suggestion: l.suggestion || '',
glycemicRisk: l.glycemic_risk || null,
};
}

// ---------- 业务接口 ----------

// 保存画像（onboarding / 我的-切换画像）
async function saveProfile({ persona, heightCm, weightKg, age, gender, activityLevel, disclaimerAck}) {
const r = await request('/api/user/profile', {
method: 'POST',
data: {
persona,
height_cm: heightCm, weight_kg: weightKg, age,
gender, activity_level: activityLevel,
disclaimer_acknowledged:!!disclaimerAck,
}
});
if (r.ok && r.data && r.data.profile) {
const mapped = mapProfile(r.data.profile);
wx.setStorageSync(PROFILE_KEY, mapped);
getApp().globalData.profile = mapped;
return { ok: true, profile: mapped, targetDetail: r.data.target_detail || null};
}
return { ok: false, error: (r.data && r.data.error) || '保存失败'};
}

async function getProfile() {
const app = getApp();
if (app.globalData.profile) return app.globalData.profile;
const cached = wx.getStorageSync(PROFILE_KEY);
if (cached && cached.persona) {
app.globalData.profile = cached;
return cached;
}
const r = await request('/api/user/profile');
if (r.ok && r.data && r.data.profile) {
const mapped = mapProfile(r.data.profile);
wx.setStorageSync(PROFILE_KEY, mapped);
app.globalData.profile = mapped;
return mapped;
}
return null;
}

// 餐食分析（只分析不落库）
//
// 402 有两种含义，reason 字段区分：
//   daily_limit_reached → 今日已达每日上限（默认 10 次），次日重置
//   quota_exhausted     → 终身免费额度用完
// 两者都是 402，但文案必须不同，否则用户会误以为要等第二天。
async function mealAnalyze({ imageDataUri, persona}) {
  const r = await request('/api/meal-analyze', {
    method: 'POST',
    data: { image: imageDataUri, persona: persona || 'takeout'}
  });
  if (r.ok && r.data && r.data.analysis) {
    // credits 由后端 consumeCredit 返回，含 todayRemaining / dailyLimit 等
    const c = r.data.credits || null;
    const remaining = c && typeof c.totalRemaining === 'number' ? c.totalRemaining : null;
    const todayRemaining = c && typeof c.todayRemaining === 'number' ? c.todayRemaining : null;
    const dailyLimit = c && typeof c.dailyLimit === 'number' ? c.dailyLimit : 10;
    cacheCredits(c); // 供首页展示当日剩余次数
    return {
      ok: true,
      analysis: mapAnalysis(r.data.analysis),
      medSafetyHit: !!r.data.med_safety_hit,
      remaining,
      credits: c,
      todayRemaining,
      dailyLimit,
      remainingText: todayRemaining === null
        ? ''
        : ('今日还可分析 ' + todayRemaining + '/' + dailyLimit + ' 次'),
    };
  }

  const isDailyLimit = r.status === 402 && r.data && r.data.error === 'daily_limit_reached';
  const isQuota = r.status === 402 && r.data && r.data.error === 'quota_exhausted';
  return {
    ok: false,
    status: r.status,
    error: (r.data && (r.data.reason || r.data.error)) || '分析失败，请重试',
    quotaExhausted: isQuota || r.status === 402,
    dailyLimitReached: isDailyLimit,
    todayRemaining: r.data && typeof r.data.credits?.todayRemaining === 'number'
      ? r.data.credits.todayRemaining : null,
  };
}

// 确认记录（落库）。早/午/晚餐多次记录会自动替换当日同餐位记录（后端实现），
// 返回 replaced=true 时前端可提示"已更新"。
//
// ⚠️ 只落库 AI 给出的建议与估算数据，**不含图片**（2026-10-17 隐私决策）：
//   用户餐食照片仅用于本次识别，服务端内存中转后即丢弃，不做任何持久化。
//   image_url 恒为空字符串。
async function saveDietLog({ date, mealType, persona, analysis}) {
const r = await request('/api/diet-log', {
method: 'POST',
data: {
log_date: date, meal_type: mealType, persona,
analysis: analysis._raw || analysis,
image_url: '',
}
});
if (r.ok) {
markCheckinDay(date); // 本地打卡记一天
return { ok: true, id: r.data && r.data.id, replaced: !!(r.data && r.data.replaced)};
}
return { ok: false, error: (r.data && r.data.error) || '保存失败'};
}

// 按日查询：当日记录 + 汇总 + 三餐齐全度 + 目标
async function getDietLog(date) {
const r = await request('/api/diet-log?date=' + encodeURIComponent(date));
if (!r.ok ||!r.data) return null;
const d = r.data;
return {
date: d.date || date,
logs: (d.logs || []).map(mapDietLog),
total: {
kcalLow: d.total? d.total.kcal_low || 0: 0,
kcalHigh: d.total? d.total.kcal_high || 0: 0,
},
mealsPresent: d.meals_present || {},
target: d.target? {
dailyKcalLow: d.target.daily_kcal_low?? null,
dailyKcalHigh: d.target.daily_kcal_high?? null,
}: null,
};
}

// 某餐位历史记录（按日期倒序）—— 含 AI 解读详情
async function getDietLogHistory(mealType, days) {
  const r = await request('/api/diet-log/history?meal_type=' + encodeURIComponent(mealType) +
    '&days=' + (days || 30));
  if (!r.ok || !r.data) return [];
  return (r.data.records || []).map((x) => ({
    id: x.id,
    date: x.log_date || '',
    persona: x.persona || 'takeout',
    dishes: (x.dishes || []).map(mapDish),
    kcalLow: x.kcal_low ?? 0,
    kcalHigh: x.kcal_high ?? 0,
    mealScore: x.meal_score ?? null,
    // AI 诊断详情（历史回看）
    suggestion: x.suggestion || '',
    highlights: Array.isArray(x.highlights) ? x.highlights : [],
    warnings: Array.isArray(x.warnings) ? x.warnings : [],
    glycemicRisk: x.glycemic_risk || null,
    giNotes: x.gi_notes || '',
    mealOrderTip: x.meal_order_tip || '',
  }));
}

// ---------- 每日打卡提醒（订阅消息） ----------
// 注意：微信一次性订阅消息发一次即消耗授权，用户需每天打开小程序重新授权
// 才能持续收到提醒，这是微信平台的限制。

// 引导用户授权订阅消息。返回 {ok}；模板未配置时返回 {ok:false, notConfigured:true}。
async function subscribeReminder() {
if (!REMINDER_TEMPLATE_ID || REMINDER_TEMPLATE_ID === 'TEMPLATE_ID_PLACEHOLDER') {
wx.showToast({ title: '提醒模板待配置', icon: 'none' });
return { ok: false, notConfigured: true};
}
return new Promise((resolve) => {
wx.requestSubscribeMessage({
tmplIds: [REMINDER_TEMPLATE_ID],
success: async (res) => {
if (res[REMINDER_TEMPLATE_ID] === 'accept') {
const r = await request('/api/reminder/subscribe', { method: 'POST' });
if (r.ok) {
wx.setStorageSync('meal_reminder_on', true);
resolve({ ok: true });
} else {
resolve({ ok: false, error: '订阅记录失败' });
}
} else {
resolve({ ok: false, denied: true});
}
},
fail: () => resolve({ ok: false}),
});
});
}

function isReminderOn() {
try { return !!wx.getStorageSync('meal_reminder_on'); } catch (_) { return false;}
}
async function saveWeight({ date, weightKg}) {
const r = await request('/api/weight-log', {
method: 'POST',
data: { log_date: date, weight_kg: weightKg}
});
if (r.ok && r.data) return { ok: true, weightKg: r.data.weight_kg};
return { ok: false, error: (r.data && r.data.error) || '保存失败'};
}

async function getWeightCurve(days) {
const r = await request('/api/weight-log?days=' + (days || 30));
if (!r.ok ||!r.data) return [];
return (r.data.points || []).map((p) => ({ date: p.log_date, weightKg: Number(p.weight_kg)}));
}

// ---------- 打卡日期 ----------
//
// 数据源已从「本地 storage」升级为「服务端 diet_logs」：
// 本地 storage 存在换机丢失、与服务端数据重复的问题。
// 现在以服务端为准，本地仅作离线兜底（网络失败时仍能看到上次缓存）。

/** 从服务端拉取区间内有记录的日期（打卡日历用）；失败返回 null */
async function fetchCheckinDays(from, to) {
  const r = await request('/api/diet-log?from=' + encodeURIComponent(from) +
    '&to=' + encodeURIComponent(to));
  if (!r.ok || !r.data || !Array.isArray(r.data.days)) return null;
  return r.data.days;
}

/** 用服务端数据覆盖本地缓存 */
function cacheCheckinDays(days) {
  try { wx.setStorageSync(CHECKIN_DAYS_KEY, days || []); } catch (_) { /* ignore */ }
}

function markCheckinDay(date) {
try {
const arr = wx.getStorageSync(CHECKIN_DAYS_KEY) || [];
if (arr.indexOf(date) < 0) {
arr.push(date);
wx.setStorageSync(CHECKIN_DAYS_KEY, arr);
}
} catch (_) { /* ignore */}
}

function getCheckinDays() {
try {
return wx.getStorageSync(CHECKIN_DAYS_KEY) || [];
} catch (_) { return [];}
}

// 连续打卡天数（截至今天或昨天，断签不惩罚只中断连续）
function calcStreak(daysInput) {
const days = Array.isArray(daysInput) ? daysInput : getCheckinDays();
const set = {};
days.forEach((d) => { set[d] = true;});
const fmt = (dt) => dt.getFullYear() + '-' +
String(dt.getMonth() + 1).padStart(2, '0') + '-' +
String(dt.getDate()).padStart(2, '0');
let streak = 0;
const cur = new Date();
if (!set[fmt(cur)]) cur.setDate(cur.getDate() - 1); // 今天没记，从昨天算起
while (set[fmt(cur)]) {
streak++;
cur.setDate(cur.getDate() - 1);
}
return streak;
}

/** 缓存最近一次后端返回的额度（首页展示当日剩余次数用） */
function cacheCredits(credits) {
  if (!credits) return;
  try {
    credits.cachedAt = Date.now();
    wx.setStorageSync(CREDITS_KEY, credits);
  } catch (_) { /* ignore */ }
}

/** 读缓存的额度；跨天则视为失效（每日次数按天重置） */
function getCachedCredits() {
  try {
    const c = wx.getStorageSync(CREDITS_KEY);
    if (!c || !c.cachedAt) return {};
    // 缓存的是哪一天的数据？用日期比对，跨天直接失效
    const d = new Date(c.cachedAt);
    const today = new Date();
    if (d.getFullYear() !== today.getFullYear()
      || d.getMonth() !== today.getMonth()
      || d.getDate() !== today.getDate()) {
      return {};
    }
    return c;
  } catch (_) { return {}; }
}

function todayStr() {
const n = new Date();
return n.getFullYear() + '-' +
String(n.getMonth() + 1).padStart(2, '0') + '-' +
String(n.getDate()).padStart(2, '0');
}

module.exports = {
API_BASE,
REMINDER_TEMPLATE_ID,
request,
wxLogin,
ensureLogin,
logout,
getToken,
saveProfile,
getProfile,
mealAnalyze,
saveDietLog,
getDietLog,
getDietLogHistory,
getCheckinDaysFromServer: fetchCheckinDays,
cacheCheckinDays,
getCachedProfile,
hasSession,
cacheCredits,
getCachedCredits,
subscribeReminder,
isReminderOn,
saveWeight,
getWeightCurve,
markCheckinDay,
getCheckinDays,
calcStreak,
todayStr,
mapProfile,
mapAnalysis,
mapDietLog,
};
