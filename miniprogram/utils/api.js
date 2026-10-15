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
function wxLogin(nickName) {
return new Promise((resolve) => {
wx.login({
success: (lr) => {
if (!lr.code) { resolve(false); return;}
wx.request({
url: API_BASE + '/api/auth/login',
method: 'POST',
data: { code: lr.code, nickName: nickName || undefined},
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
imageUrl: l.image_url || '',
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
async function mealAnalyze({ imageDataUri, persona}) {
const r = await request('/api/meal-analyze', {
method: 'POST',
data: { image: imageDataUri, persona: persona || 'takeout'}
});
if (r.ok && r.data && r.data.analysis) {
return { ok: true, analysis: mapAnalysis(r.data.analysis), medSafetyHit:!!r.data.med_safety_hit};
}
return {
ok: false, status: r.status,
error: (r.data && r.data.error) || '分析失败，请重试',
quotaExhausted: r.status === 402,
};
}

// 确认记录（落库）
async function saveDietLog({ date, mealType, persona, analysis, imageUrl}) {
const r = await request('/api/diet-log', {
method: 'POST',
data: {
log_date: date, meal_type: mealType, persona,
analysis: analysis._raw || analysis,
image_url: imageUrl || '',
}
});
if (r.ok) {
markCheckinDay(date); // 本地打卡记一天
return { ok: true, id: r.data && r.data.id};
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

// 体重：记录（upsert）/ 曲线
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

// ---------- 本地打卡（MVP：后端暂无按月查询接口，打卡日期记本地） ----------
// TODO(后端对齐): 未来加 GET /api/diet-log?from=&to= 后，改从服务端拉取。

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
function calcStreak() {
const set = {};
getCheckinDays().forEach((d) => { set[d] = true;});
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

function todayStr() {
const n = new Date();
return n.getFullYear() + '-' +
String(n.getMonth() + 1).padStart(2, '0') + '-' +
String(n.getDate()).padStart(2, '0');
}

module.exports = {
API_BASE,
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
