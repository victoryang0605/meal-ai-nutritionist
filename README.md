# 三餐 AI 营养师（meal-ai-nutritionist）

拍三餐 → AI 识别菜品 → 热量/营养素估算 + 饮食评分 + 减脂/控糖建议 + 饮食档案。

微信小程序后端（Express + TypeScript），AI 链路：DeepSeek vision 主通道（15s 超时不重试）→ Agnes 降级通道。

> ⚠️ **本仓库与 `vibeshot`（声影印记 AI 写真）完全独立**：仓库、部署、数据库、环境变量、微信小程序全部隔离，仅复用经过验证的通用后端模块（鉴权链、限流、OSS、AI 调用链、虚拟支付）。两个产品的问题互不影响。

## 技术栈

- Node 20 + Express 4 + TypeScript（ESM）
- MySQL 8.0（微信云托管 MySQL；启动时自动建库建表）
- DeepSeek（`deepseek-v4-flash`，OpenAI 兼容）/ Agnes AI（降级）
- 微信虚拟支付（米大师）：会员 / 次数包等虚拟商品强制走虚拟支付
- 构建：esbuild（`dist/server.mjs`）；Docker 部署

## 目录结构

```
├── server.ts                  # 后端入口：鉴权、AI 调用链、路由
├── src/
│   ├── db.ts                  # MySQL：用户/令牌/额度/订单/通用任务表（自动建表）
│   ├── rate-limit.ts          # 限流（全局/IP/登录/支付/LLM 额度）
│   ├── oss-image.ts           # 阿里云 OSS 图片上传 + 自建图床回退
│   ├── temp-image-store.ts    # 本服务临时图床（10 分钟有效）
│   └── virtual-pay.ts         # 微信虚拟支付：签名/验签/解密/下单参数
├── scripts/
│   ├── prompts/meal-analyze.md  # 双画像识图 prompt（外卖党/控糖），生产 prompt 正本
│   └── meal-prompt-test.mjs     # prompt 回归测试脚本（见下）
├── Dockerfile
├── .env.example               # 环境变量模板（只放占位符，绝不提交真实 Key）
└── package.json
```

## 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量模板并填写（本地 .env 不进仓库）
cp .env.example .env

# 3. 启动（tsx 热重载）
npm run dev

# 4. 类型检查
npm run lint
```

生产构建与启动：`npm run build && npm start`（产物 `dist/server.mjs`）。

## Prompt 回归测试

`scripts/meal-prompt-test.mjs` 用真实图片验证 prompt 输出（双画像 × JSON 校验）：

```bash
export DEEPSEEK_API_KEY='...'   # 只放终端环境变量，不写进文件
node scripts/meal-prompt-test.mjs \
  --images <测试图片目录> \
  --prompt scripts/prompts/meal-analyze.md \
  --out ./test-report
```

改 prompt 后必须跑一遍，`report.md` 全绿才能合。

## 分支工作流

- `main`：唯一长期分支，自动部署 watches main。**直接推 main 只允许骨架/文档类提交**，功能开发一律走分支。
- 功能分支：`arlo/<功能名>`，Arlo 推分支 → Victor 在 GitHub 网页端 Review（Compare & pull request → Files changed）→ Merge pull request → 删除分支。
- 后端-only 改动不需要微信重新审核（新增类目/功能提审除外）。

## 安全基线（必读）

1. **新仓库是 public 的**：只能提交 `.env.example`（占位符）。任何真实 Key/Secret 只放在本地 `.env`（已在 `.gitignore`）或云托管控制台的环境变量。提交前用 `git status` + `git diff --cached` 自查。
2. 所有消耗 AI 额度的接口必须同时满足：**登录校验**（`resolveOpenid` → 401）+ **限流**（`RL.llmCostLimiter`）+ **额度校验**（`DB.calcCredits` → 402）。
3. 生产环境绝不配置 `DEV_USER` / `DEV_PASS`（开发登录后门）。
4. 营养建议 ≠ 医疗诊断：prompt 与接口文案必须带固定免责声明；**禁止任何用药/调药/停药建议**（见 prompt 硬约束）。

## 相关文档

- 开发计划：`~/workspace/meal-ai-nutritionist/三餐AI营养师_开发计划.md`（工作区，非仓库内容）
- W1 prompt 测试报告：`~/workspace/meal-ai-nutritionist/test-report/report.md`
