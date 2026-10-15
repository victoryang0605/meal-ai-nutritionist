// rate-limit.ts — 接口限流（防API Key 被刷爆）
// ============================================================
// 背景（2026-10-13 安全事件）：
//   DeepSeek API Key 在 4 小时内被刷空，余额耗尽。
//   根因之一：后端**零限流**——任何人都能直接打公开接口，
//   而这些接口在服务端用你的 Key 调第三方大模型，费用由你承担。
//
// 核心思路：**按调用方限流，而非按接口限流**。
//   攻击者通常只打少数几个「能消耗额度」的接口（如 /api/translate），
//   按接口限流反而容易被换接口绕过；按 IP/用户维度限流才拦得住。
//
// 防护分层：
//   1. 全局限流：兜底，防止单个 IP 疯狂打任何接口
//   2. 敏感接口限流：对会消耗第三方额度的接口单独设更严的阈值
//   3. 鉴权校验：付费/消耗资源的接口应同时校验用户身份
//
// ⚠️ 生产环境建议同时在云托管网关层配置限流规则（双保险）。
//    本模块是应用层防护，能拦住「直接打域名」的常见刷取。
// ============================================================

/** 限流器存储：key → { count, resetAt } */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** 定期清理过期桶，防止内存无限增长 */
let lastSweep = Date.now();
function sweep(now: number) {
  // 每 5 分钟扫一次
  if (now - lastSweep < 5 * 60 * 1000) return;
  lastSweep = now;
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitOptions {
  /** 时间窗口（毫秒），默认 1 分钟 */
  windowMs?: number;
  /** 窗口内最大请求数 */
  max?: number;
  /** 桶标识前缀，便于区分不同规则 */
  name?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 建议的 Retry-After 秒数 */
  retryAfter: number;
}

/**
 * 检查是否超出限流。
 *
 * @param key 限流维度标识（如 IP、用户 openid）
 * @param opts 限流规则
 */
export function checkRateLimit(key: string, opts: RateLimitOptions = {}): RateLimitResult {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const name = opts.name ? `${opts.name}:` : '';

  const now = Date.now();
  sweep(now);

  const fullKey = `${name}${key}`;
  const bucket = buckets.get(fullKey);

  if (!bucket || bucket.resetAt <= now) {
    // 新窗口
    buckets.set(fullKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfter: 0 };
  }

  bucket.count += 1;
  const remaining = Math.max(0, max - bucket.count);

  if (bucket.count > max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }
  return { allowed: true, remaining, retryAfter: 0 };
}

/**
 * Express 中间件工厂。
 *
 * @param opts 限流规则
 */
export function rateLimitMiddleware(opts: RateLimitOptions = {}) {
  return (req: any, res: any, next: any) => {
    // 取调用方 IP。云托管/反向代理下 req.ip 可能被设为代理 IP，
    // 故按优先级尝试多个来源，并取第一个存在的。
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';

    const result = checkRateLimit(ip, opts);

    res.setHeader('X-RateLimit-Limit', String(opts.max ?? 60));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      console.warn(
        `[限流] 触发拦截 ip=${ip} 规则=${opts.name || 'global'} ` +
        `上限=${opts.max ?? 60}/${(opts.windowMs ?? 60000) / 1000}s`
      );
      return res.status(429).json({
        error: '请求过于频繁，请稍后再试',
        retryAfter: result.retryAfter,
      });
    }
    next();
  };
}

/** 供监控/诊断查询当前桶数量 */
export function bucketCount(): number {
  return buckets.size;
}

/** 清空所有限流记录（仅测试用） */
export function resetAll(): void {
  buckets.clear();
}

// ============================================================
// 预置规则
// ------------------------------------------------------------
// 阈值依据：正常用户单次分析会调用 1~3 次第三方接口；
// 留足冗余的同时，让「批量脚本刷取」在几分钟内即被拦下。
// ============================================================

/** 全局限流：单 IP 每分钟最多 120 次（正常用户远达不到） */
export const globalLimiter = rateLimitMiddleware({ name: 'global', max: 120, windowMs: 60_000 });

/**
 * 消耗第三方额度的接口：单 IP 每分钟最多 20 次。
 * 覆盖 /api/translate、识图、异步任务等会花钱的路径。
 */
export const llmCostLimiter = rateLimitMiddleware({ name: 'llm', max: 20, windowMs: 60_000 });

/** 登录类接口：防撞库，单 IP 每分钟 10 次 */
export const authLimiter = rateLimitMiddleware({ name: 'auth', max: 10, windowMs: 60_000 });

/** 支付下单：单 IP 每分钟 10 次 */
export const payLimiter = rateLimitMiddleware({ name: 'pay', max: 10, windowMs: 60_000 });