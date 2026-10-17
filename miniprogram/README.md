# 三餐有数 · 小程序前端

微信原生小程序（wxml / wxss / js），浅色清新健康风。

## 上线前必做（Victor）

1. **AppID**：`project.config.json` 里的 `appid` 已配置为真实值。
   ⚠️ AppSecret 等密钥**只在后端 `.env` / 云托管环境变量**中，绝不入库。
2. **后端域名**：`utils/api.js` 顶部的 `API_BASE` 已设为 `https://api.cooperelate.com`，把该域名加到小程序后台
   「开发管理 → 开发设置 → 服务器域名」的 request 合法域名里。

## 隐私策略：图片不落库（2026-10-17 定）

用户餐食照片**仅用于当次识别，服务端内存中转后即丢弃** —— 不写磁盘、不上传对象存储、不进数据库。
`diet_logs.image_url` 恒为空字符串，饮食记录只保存 AI 给出的建议与估算数据。

三道防御：server.ts 路由层恒置空 → db.ts `insertDietLog` 硬编码空串 → 前端不传该字段。
因此本项目**不需要** `src/oss-image.ts`。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss      # 全局：浅色主题、tabBar（首页/打卡/我的）
├── project.config.json               # appid 占位符见上
├── sitemap.json
├── utils/
│   ├── api.js    # 所有接口封装；后端字段映射（snake_case→camelCase）只在这里做
│   └── image.js  # 选图→压缩→dataURI（含 compressImage 超时兜底）
└── pages/
    ├── onboarding/  # 首次进入：双画像选择 + 身体数据建档（控糖强制知悉确认）
    ├── index/       # 首页：热量预算条 / 升糖总览 + 拍三餐 + 三餐时间线
    ├── analyze/     # 分析结果：菜品列表、评分环、建议、确认记录（含删菜修正）
    ├── checkin/     # 打卡 tab：月历绿点 + 连续打卡（本地记，断签不惩罚）
    ├── weight/      # 体重：数字键盘 + 一键沿用 + 30 天 canvas 曲线
    ├── me/          # 我的：画像切换（切控糖重弹确认）、目标查看、免责声明、退出
    └── disclaimer/  # 免责声明静态页
```

## 与后端的字段映射（utils/api.js 内集中处理）

| 后端（snake_case） | 前端（camelCase） |
|---|---|
| persona | persona（takeout \| glycemic） |
| height_cm / weight_kg / age / gender / activity_level | heightCm / weightKg / age / gender / activityLevel |
| daily_kcal_low / daily_kcal_high | dailyKcalLow / dailyKcalHigh |
| disclaimer_acknowledged | disclaimerAck |
| dishes[].name / portion_g_est / kcal_range / protein_g / carb_g / fat_g / fiber_g / confidence | dishes[].name / portion / kcalRange / protein / carb / fat / fiber / confidence（confidence<0.6 显示"估算"） |
| meal_score / suggestion / highlights / warnings | mealScore / suggestion / highlights / warnings |
| glycemic_risk / gi_notes / meal_order_tip | glycemicRisk / giNotes / mealOrderTip |
| diet-log: log_date / meal_type / kcal_low / kcal_high / meal_score | date / mealType / kcalLow / kcalHigh / mealScore |
| diet-log GET: total{}, meals_present{}, target{} | total{kcalLow,kcalHigh} / mealsPresent / target{dailyKcalLow,dailyKcalHigh} |
| weight-log: points[].log_date / weight_kg | points[].date / weightKg |

## 已完成的待对齐项（原先的后端 W2 分支已合并到 main）

- ✅ 打卡月历的绿点已改为从服务端 `GET /api/diet-log?from=&to=` 拉取，
  本地 storage 仅作离线兜底（换机不再丢历史绿点）。
- `/api/meal-analyze` 返回的 `credits` 已接入 analyze 页顶部提示条（「今日还可分析 N 次」）。

## 合规

- 所有 AI 文案展示处标注"AI 生成，仅供参考"。
- 控糖相关页面固定页脚："营养估算不构成医疗建议，请咨询医生或注册营养师"。
- 全端不出现"保证瘦 X 斤"类表述。
