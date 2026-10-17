// db.ts — MySQL 8.0 数据库层（微信云托管 MySQL）
import mysql from 'mysql2/promise';
import crypto from 'crypto';

// ============================================================
// 连接池（延迟创建——先建库再初始化池）
// ============================================================
// ⚠️ 惰性读取：避免 ESM import 静态提升导致 .env 值丢失（详见 server.ts env() 说明）
const DB_NAME = () => (process.env.MYSQL_DATABASE || 'meal_nutritionist').trim();
const DB_HOST = () => process.env.MYSQL_HOST || '127.0.0.1';
const DB_PORT = () => Number(process.env.MYSQL_PORT) || 3306;
const DB_USER = () => process.env.MYSQL_USER || 'root';
const DB_PASS = () => process.env.MYSQL_PASSWORD || '';
let pool: mysql.Pool;

function getPool(): mysql.Pool {
  if (!pool) throw new Error('数据库未初始化，请先调用 initDB()');
  return pool;
}

// ============================================================
// 初始化：建库 + 建表（幂等，首次启动自动完成）
// ============================================================
export async function initDB() {
  // 1. 先用无 database 的连接创建数据库
  const initConn = await mysql.createConnection({
    host:     DB_HOST(),
    port:     DB_PORT(),
    user:     DB_USER(),
    password: DB_PASS(),
    charset:  'utf8mb4',
  });

  await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME()}\` DEFAULT CHARSET utf8mb4`);
  await initConn.end();

  // 2. 用指定数据库创建连接池
  pool = mysql.createPool({
    host:     DB_HOST(),
    port:     DB_PORT(),
    user:     DB_USER(),
    password: DB_PASS(),
    database: DB_NAME(),
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });

  // 3. 建表
  const conn = await getPool().getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        openid          VARCHAR(64) PRIMARY KEY,
        nick_name       VARCHAR(64) DEFAULT '微信用户',
        avatar_url      VARCHAR(512) DEFAULT '',
        phone           VARCHAR(20) DEFAULT '',
        free_limit      INT DEFAULT 50,
        free_used       INT DEFAULT 0,
        paid_credits    INT DEFAULT 0,
        total_purchased INT DEFAULT 0,
        session_key     VARCHAR(128) DEFAULT '',
        created_at      BIGINT NOT NULL,
        last_login_at   BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // session_key 列迁移：虚拟支付的用户态签名需要它（老库可能无此列）
    try {
      await conn.execute("ALTER TABLE users ADD COLUMN session_key VARCHAR(128) DEFAULT ''");
    } catch (e: any) {
      if (!/Duplicate column/i.test(e?.message || '')) {
        console.warn('[DB] session_key 列迁移异常:', e?.message);
      }
    }

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tokens (
        token  VARCHAR(64) PRIMARY KEY,
        openid VARCHAR(64) NOT NULL,
        INDEX idx_tokens_openid (openid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS purchases (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        openid     VARCHAR(64) NOT NULL,
        plan_id    VARCHAR(32) NOT NULL,
        plan_name  VARCHAR(64) NOT NULL,
        credits    INT NOT NULL,
        price      DECIMAL(10,2) NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX idx_purchases_openid (openid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS usage_logs (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        openid     VARCHAR(64) NOT NULL,
        type       ENUM('free','paid') NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX idx_usage_openid (openid),
        INDEX idx_usage_date (openid, type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        openid         VARCHAR(64) NOT NULL,
        out_trade_no   VARCHAR(64) NOT NULL UNIQUE,
        plan_id        VARCHAR(32) NOT NULL,
        plan_name      VARCHAR(64) NOT NULL,
        amount         DECIMAL(10,2) NOT NULL,
        credits        INT NOT NULL,
        status         ENUM('pending','paid','failed') DEFAULT 'pending',
        prepay_id      VARCHAR(64) DEFAULT '',
        transaction_id VARCHAR(64) DEFAULT '',
        created_at     BIGINT NOT NULL,
        paid_at        BIGINT DEFAULT NULL,
        INDEX idx_orders_openid (openid),
        INDEX idx_orders_out_trade_no (out_trade_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 异步任务（提交 -> 轮询）：持久化到 MySQL，避免云托管多实例/实例重启导致任务丢失
    // 通用任务表：餐食分析、AI 任务等耗时操作都可复用（W2 会再加 meal_logs / weight_logs / user_profiles 等业务表）
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id     VARCHAR(64) PRIMARY KEY,
        openid      VARCHAR(64) NOT NULL,
        status      ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
        result      MEDIUMTEXT,
        error       TEXT,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        INDEX idx_tasks_openid (openid),
        INDEX idx_tasks_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ============================================================
    // 三餐 AI 营养师业务表（W2）
    // ============================================================

    // 用户画像：onboarding 收集，用于计算每日目标热量区间
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id               VARCHAR(64) PRIMARY KEY,
        persona               ENUM('takeout','glycemic') NOT NULL DEFAULT 'takeout',
        height_cm             DECIMAL(5,1) DEFAULT NULL,
        weight_kg             DECIMAL(5,1) DEFAULT NULL,
        age                   INT DEFAULT NULL,
        gender                ENUM('male','female') DEFAULT NULL,
        activity_level        ENUM('sedentary','light','moderate','active','very_active') DEFAULT 'light',
        daily_kcal_low        INT DEFAULT NULL,
        daily_kcal_high       INT DEFAULT NULL,
        disclaimer_acknowledged TINYINT(1) NOT NULL DEFAULT 0,
        created_at            BIGINT NOT NULL,
        updated_at            BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 饮食记录：区间存 low/high 两个 INT，便于按日汇总求和
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS diet_logs (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_id       VARCHAR(64) NOT NULL,
        log_date      DATE NOT NULL,
        meal_type     ENUM('breakfast','lunch','dinner','snack') NOT NULL,
        image_url     VARCHAR(1024) DEFAULT '',
        persona       ENUM('takeout','glycemic') NOT NULL DEFAULT 'takeout',
        dishes_json   MEDIUMTEXT,
        kcal_low      INT DEFAULT NULL,
        kcal_high     INT DEFAULT NULL,
        protein_low   INT DEFAULT NULL,
        protein_high  INT DEFAULT NULL,
        carb_low      INT DEFAULT NULL,
        carb_high     INT DEFAULT NULL,
        fat_low       INT DEFAULT NULL,
        fat_high      INT DEFAULT NULL,
        fiber_low     INT DEFAULT NULL,
        fiber_high    INT DEFAULT NULL,
        meal_score    INT DEFAULT NULL,
        suggestion    TEXT,
        glycemic_risk VARCHAR(16) DEFAULT NULL,
        highlights_json MEDIUMTEXT,          -- AI 亮点（数组，JSON）
        warnings_json   MEDIUMTEXT,          -- AI 警示（数组，JSON）
        gi_notes        TEXT,                -- 控糖：升糖指数说明
        meal_order_tip  TEXT,                -- 控糖：进食顺序建议
        created_at    BIGINT NOT NULL,
        INDEX idx_diet_user_date (user_id, log_date),
        INDEX idx_diet_user_meal (user_id, log_date, meal_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ---- 幂等迁移：给已存在的表补 AI 解读字段（2026-10-17）----
    // CREATE TABLE IF NOT EXISTS 不会改动已存在的表，老库需要单独 ALTER。
    // 先查 information_schema 再决定是否 ALTER，保证重复启动不报错。
    const aiDiagnosisCols = [
      ['highlights_json', 'MEDIUMTEXT'],
      ['warnings_json', 'MEDIUMTEXT'],
      ['gi_notes', 'TEXT'],
      ['meal_order_tip', 'TEXT'],
    ] as const;
    for (const [col, type] of aiDiagnosisCols) {
      const [exists] = await conn.execute(
        `SELECT COUNT(*) as c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'diet_logs' AND COLUMN_NAME = ?`,
        [col]
      ) as any;
      if (!exists[0].c) {
        await conn.execute(`ALTER TABLE diet_logs ADD COLUMN ${col} ${type}`);
        console.log(`[db] diet_logs 已新增列 ${col} ${type}`);
      }
    }

    // 体重记录：同一天重复记录则覆盖（UNIQUE KEY + upsert）
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS weight_logs (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    VARCHAR(64) NOT NULL,
        log_date   DATE NOT NULL,
        weight_kg  DECIMAL(5,1) NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uk_weight_user_date (user_id, log_date),
        INDEX idx_weight_user_date (user_id, log_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 每日打卡提醒订阅：用户在小程序端通过 wx.requestSubscribeMessage 授权一次，
    // 后端凭该授权在当日 20:00 发送订阅消息。used=1 表示当日已发送（防重复）；
    // 定时任务每天开始时先把 used 重置为 0（一次性订阅授权发一次即消耗，用户需
    // 重新打开小程序授权才能继续收到提醒，这是微信平台的限制）。
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS reminder_subscriptions (
        user_id       VARCHAR(64) PRIMARY KEY,
        subscribed_at BIGINT NOT NULL,
        used          TINYINT(1) NOT NULL DEFAULT 0,
        updated_at    BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 为开发测试账号预置 demo 订单（仅当环境变量 DEV_USER 配置时）
    if (process.env.DEV_USER) {
      const testOpenid = 'dev_test_' + process.env.DEV_USER;
      const now = Date.now();
      const demoOrders = [
        { out_trade_no: 'demo_001', plan_id: 'trial', plan_name: '尝鲜包', amount: 1, credits: 8 },
        { out_trade_no: 'demo_002', plan_id: 'basic', plan_name: '灵感包', amount: 9.9, credits: 80 },
      ];
      for (const o of demoOrders) {
        await conn.execute(
          `INSERT IGNORE INTO orders (openid, out_trade_no, plan_id, plan_name, amount, credits, status, prepay_id, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, 'paid', 'demo_prepay', ?, ?)`,
          [testOpenid, o.out_trade_no, o.plan_id, o.plan_name, o.amount, o.credits, now - 86400000, now - 86400000]
        );
      }
      console.log('[DB] 测试账号 demo 订单已就绪');
    }
  } finally {
    conn.release();
  }
}

// ============================================================
// 用户操作
// ============================================================

/** 获取或创建用户。首次登录自动注册，赠送 50 次终身免费额度 */
export async function getOrCreateUser(openid: string, extra?: { nickName?: string; avatarUrl?: string }) {
  const [rows] = await getPool().execute('SELECT * FROM users WHERE openid = ?', [openid]) as any;
  const now = Date.now();

  if (rows.length === 0) {
    await getPool().execute(
      `INSERT INTO users (openid, nick_name, avatar_url, phone, free_limit, free_used, paid_credits, total_purchased, created_at, last_login_at)
       VALUES (?, ?, ?, '', 5, 0, 0, 0, ?, ?)`,
      [openid, extra?.nickName || '微信用户', extra?.avatarUrl || '', now, now]
    );
    return {
      openid, nick_name: extra?.nickName || '微信用户', avatar_url: extra?.avatarUrl || '',
      phone: '', free_limit: 50, free_used: 0, paid_credits: 0, total_purchased: 0,
      created_at: now, last_login_at: now,
    };
  }

  // 更新登录时间与昵称
  const user = rows[0];
  const newNick = extra?.nickName || user.nick_name;
  await getPool().execute('UPDATE users SET nick_name = ?, last_login_at = ? WHERE openid = ?', [newNick, now, openid]);
  user.nick_name = newNick;
  user.last_login_at = now;
  return user;
}

/** 签发登录 token */
export async function createToken(openid: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');
  await getPool().execute('INSERT INTO tokens (token, openid) VALUES (?, ?) ON DUPLICATE KEY UPDATE openid = VALUES(openid)', [token, openid]);
  return token;
}

/** 通过 token 解析 openid */
export async function resolveOpenidByToken(token: string): Promise<string | null> {
  const [rows] = await getPool().execute('SELECT openid FROM tokens WHERE token = ?', [token]) as any;
  return rows.length > 0 ? rows[0].openid : null;
}

/**
 * 保存 session_key（虚拟支付用户态签名需要）
 * @param sessionKey 微信 jscode2session 返回的 session_key
 */
export async function saveSessionKey(openid: string, sessionKey: string): Promise<void> {
  if (!sessionKey) return;
  await getPool().execute('UPDATE users SET session_key = ? WHERE openid = ?', [sessionKey, openid]);
}

/**
 * 读取 session_key（虚拟支付用户态签名需要）
 * @returns 无记录时返回空字符串
 */
export async function getSessionKey(openid: string): Promise<string> {
  const [rows] = await getPool().execute('SELECT session_key FROM users WHERE openid = ?', [openid]) as any;
  return rows.length > 0 ? (rows[0].session_key || '') : '';
}

/** 更新用户昵称 */
export async function updateNickName(openid: string, nickName: string) {
  await getPool().execute('UPDATE users SET nick_name = ? WHERE openid = ?', [nickName, openid]);
}

/** 更新手机号 */
export async function updatePhone(openid: string, phone: string) {
  await getPool().execute('UPDATE users SET phone = ? WHERE openid = ?', [phone, openid]);
}

/** 获取用户完整信息 */
export async function getUser(openid: string) {
  const [rows] = await getPool().execute('SELECT * FROM users WHERE openid = ?', [openid]) as any;
  return rows.length > 0 ? rows[0] : null;
}

// ============================================================
// 额度计算与消耗
// ============================================================

/** 获取今日使用次数 */
export async function getTodayUsageCount(openid: string): Promise<number> {
  const [rows] = await getPool().execute(
    `SELECT COUNT(*) as cnt FROM usage_logs
     WHERE openid = ? AND DATE(FROM_UNIXTIME(created_at/1000)) = CURDATE()`,
    [openid]
  ) as any;
  return rows[0].cnt;
}

/**
 * 每日调用上限（默认 10 次/天）
 *
 * 背景（2026-10-17）：AI 接口有每日调用成本约束，产品侧约定
 * 每个用户每天最多拍摄分析 10 次。与「终身免费额度 free_limit」
 * 是两套独立限制：
 *   · dailyLimit —— 按天重置，控当日调用成本
 *   · freeLimit  —— 终身累计，控总成本
 * 两项任一触发都会拒绝，reason 字段用于前端区分提示文案。
 */
export function dailyLimit(): number {
  const n = Number(process.env.DAILY_ANALYZE_LIMIT || 10);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

/** 计算用户额度（返回给前端） */
export async function calcCredits(openid: string) {
  const user = await getUser(openid);
  const dLimit = dailyLimit();
  if (!user) {
    return {
      isLoggedIn: false, freeLimit: 50, freeUsed: 0, freeRemaining: 50,
      paidCredits: 0, totalRemaining: 50, isPaidUser: false,
      todayUsed: 0, todayRemaining: dLimit, dailyLimit: dLimit,
    };
  }

  const freeRemaining = Math.max(0, user.free_limit - user.free_used);
  const paidCredits = user.paid_credits || 0;
  const todayCount = await getTodayUsageCount(openid);

  return {
    isLoggedIn: true,
    isPaidUser: user.total_purchased > 0 || paidCredits > 0,
    freeLimit: user.free_limit,
    freeUsed: user.free_used,
    freeRemaining,
    paidCredits,
    totalRemaining: freeRemaining + paidCredits,
    todayUsed: todayCount,
    dailyLimit: dLimit,
    todayRemaining: Math.max(0, dLimit - todayCount),
  };
}

/** 消耗一次额度（先终身免费、后付费）- 必须已登录 */
export async function consumeCredit(openid: string): Promise<{ ok: boolean; reason?: string; credits?: any }> {
  const user = await getUser(openid);
  if (!user) return { ok: false, reason: 'not_logged_in', credits: await calcCredits(openid) };

  const freeRemaining = Math.max(0, user.free_limit - user.free_used);
  const now = Date.now();

  if (freeRemaining > 0) {
    await getPool().execute('UPDATE users SET free_used = free_used + 1 WHERE openid = ? AND free_used < free_limit', [openid]);
    await getPool().execute('INSERT INTO usage_logs (openid, type, created_at) VALUES (?, ?, ?)', [openid, 'free', now]);
  } else if (user.paid_credits > 0) {
    await getPool().execute('UPDATE users SET paid_credits = paid_credits - 1 WHERE openid = ? AND paid_credits > 0', [openid]);
    await getPool().execute('INSERT INTO usage_logs (openid, type, created_at) VALUES (?, ?, ?)', [openid, 'paid', now]);
  } else {
    return { ok: false, reason: 'quota_exhausted', credits: await calcCredits(openid) };
  }

  return { ok: true, credits: await calcCredits(openid) };
}

// ============================================================
// 购买
// ============================================================

/**
 * 记录购买并增加付费次数
 * @param priceCents 套餐价格（单位：分，整数）—— 避免浮点误差
 */
export async function recordPurchase(openid: string, plan: { id: string; name: string; credits: number; priceCents: number }) {
  const now = Date.now();
  // 数据库 amount/price 列为 DECIMAL(10,2)，按「元」存储；
  // 传参统一用整数分，写入前换算，避免 9.9 元这类值出现浮点误差
  const priceYuan = (plan.priceCents / 100).toFixed(2);
  await getPool().execute(
    'INSERT INTO purchases (openid, plan_id, plan_name, credits, price, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [openid, plan.id, plan.name, plan.credits, priceYuan, now]
  );
  await getPool().execute(
    'UPDATE users SET paid_credits = paid_credits + ?, total_purchased = total_purchased + ? WHERE openid = ?',
    [plan.credits, plan.credits, openid]
  );
  return calcCredits(openid);
}

/** 获取用户购买记录 */
export async function getPurchaseHistory(openid: string) {
  const [rows] = await getPool().execute('SELECT * FROM purchases WHERE openid = ? ORDER BY created_at DESC', [openid]);
  return rows;
}

// ============================================================
// 订单（微信支付）
// ============================================================

/**
 * 创建待支付订单
 * @param priceCents 套餐价格（单位：分，整数）
 * @param prepayId 道具 ID（虚拟支付场景存 productId，普通支付存 prepayId）
 */
export async function createOrder(openid: string, outTradeNo: string, plan: { id: string; name: string; priceCents: number; credits: number }, prepayId: string) {
  const priceYuan = (plan.priceCents / 100).toFixed(2);
  await getPool().execute(
    'INSERT INTO orders (openid, out_trade_no, plan_id, plan_name, amount, credits, status, prepay_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [openid, outTradeNo, plan.id, plan.name, priceYuan, plan.credits, 'pending', prepayId, Date.now()]
  );
}

/** 支付成功 → 更新订单状态 + 发放次数 */
export async function confirmPayment(outTradeNo: string, transactionId: string) {
  const [rows] = await getPool().execute('SELECT * FROM orders WHERE out_trade_no = ? AND status = ?', [outTradeNo, 'pending']) as any;
  if (rows.length === 0) return null;

  const order = rows[0];
  await getPool().execute(
    'UPDATE orders SET status = ?, transaction_id = ?, paid_at = ? WHERE out_trade_no = ?',
    ['paid', transactionId, Date.now(), outTradeNo]
  );

  // 发放付费次数
  await getPool().execute(
    'UPDATE users SET paid_credits = paid_credits + ?, total_purchased = total_purchased + ? WHERE openid = ?',
    [order.credits, order.credits, order.openid]
  );

  return order;
}

// ============================================================
// 虚拟支付（米大师）相关
// ------------------------------------------------------------
// 与普通微信支付的关键差异：发货依据是【消息推送】或【主动轮询】，
// 不依赖客户端 success 回调（官方明确该回调可能丢失）。
// ============================================================

/**
 * 确认虚拟支付订单并发放次数（**幂等**）。
 *
 * 被两处调用：
 *   1. /api/virtual-pay/notify —— 微信发货推送（官方推荐路径）
 *   2. /api/virtual-pay/order-status —— 前端轮询兜底
 *
 * 幂等：已 paid 的订单不会重复发放，避免重复到账。
 *
 * @param outTradeNo 业务订单号
 * @param transactionId 微信支付交易号（或来源标识）
 * @param attachCredits attach 中携带的次数，仅用于交叉校验（以订单表为准）
 */
export async function confirmVirtualPayOrder(
  outTradeNo: string,
  transactionId: string,
  attachCredits?: number
) {
  const [rows] = await getPool().execute(
    'SELECT * FROM orders WHERE out_trade_no = ? AND status = ?', [outTradeNo, 'pending']
  ) as any;

  if (rows.length === 0) {
    // 已处理过（幂等）：返回记录，不重复发放
    const [exist] = await getPool().execute(
      'SELECT openid, plan_name, credits FROM orders WHERE out_trade_no = ?', [outTradeNo]
    ) as any;
    if (exist.length > 0) {
      return { ...exist[0], alreadyProcessed: true, credits: await calcCredits(exist[0].openid) };
    }
    return null;
  }

  const order = rows[0];
  const credits = order.credits; // 以订单表记录为准，防前端篡改

  await getPool().execute(
    'UPDATE orders SET status = ?, transaction_id = ?, paid_at = ? WHERE out_trade_no = ?',
    ['paid', transactionId, Date.now(), outTradeNo]
  );

  await getPool().execute(
    'UPDATE users SET paid_credits = paid_credits + ?, total_purchased = total_purchased + ? WHERE openid = ?',
    [credits, credits, order.openid]
  );

  console.log(
    `[DB] 虚拟支付发货 +${credits}次 订单=${outTradeNo} 用户=${order.openid.slice(0, 8)}…` +
    (attachCredits && attachCredits !== credits ? ' (attach 额度与订单不一致，已按订单为准)' : '')
  );

  return { ...order, credits: await calcCredits(order.openid) };
}

/** 查询订单支付状态与最新额度（供前端轮询确认发货） */
export async function getCreditsByOrder(outTradeNo: string, openid: string) {
  const [rows] = await getPool().execute(
    'SELECT status FROM orders WHERE out_trade_no = ? AND openid = ?', [outTradeNo, openid]
  ) as any;
  if (rows.length === 0) return null;
  return {
    paid: rows[0].status === 'paid',
    credits: await calcCredits(openid),
  };
}

/** 查询用户订单列表（最近的在前） */
export async function listOrders(openid: string) {
  const [rows] = await getPool().execute(
    'SELECT id, out_trade_no, plan_id, plan_name, amount, credits, status, created_at, paid_at FROM orders WHERE openid = ? ORDER BY created_at DESC',
    [openid]
  );
  return rows;
}

// ============================================================
// 统计
// ============================================================

export async function getStats() {
  const [[{ cnt: totalUsers }]] = await getPool().execute('SELECT COUNT(*) as cnt FROM users') as any;
  const [[{ cnt: newToday }]] = await getPool().execute(
    "SELECT COUNT(*) as cnt FROM users WHERE DATE(FROM_UNIXTIME(created_at/1000)) = CURDATE()"
  ) as any;
  const [[{ cnt: totalPurchased }]] = await getPool().execute('SELECT COALESCE(SUM(total_purchased),0) as cnt FROM users') as any;
  const [[{ cnt: totalUsage }]] = await getPool().execute('SELECT COUNT(*) as cnt FROM usage_logs') as any;
  const [[{ cnt: todayUsage }]] = await getPool().execute(
    "SELECT COUNT(*) as cnt FROM usage_logs WHERE DATE(FROM_UNIXTIME(created_at/1000)) = CURDATE()"
  ) as any;

  return { totalUsers, newUsersToday: newToday, totalPurchased, totalUsage, todayUsage };
}

export async function exportUsers() {
  const [rows] = await getPool().execute(
    'SELECT openid, nick_name, phone, free_limit, free_used, paid_credits, total_purchased, created_at, last_login_at FROM users'
  );
  return rows;
}

// ============================================================
// 异步识图任务（提交 -> 轮询）
// ------------------------------------------------------------
// 为什么落库而不是放内存 Map：
//   云托管支持多实例扩容 + 实例会因发版/休眠自动重启，
//   内存态任务会导致「用户提交成功但轮询 404」的丢单。
//   任务生命周期仅 10 分钟，落MySQL 成本可忽略。
// ============================================================

export type TaskStatus = 'pending' | 'done' | 'failed';

/** 创建 pending 任务 */
export async function createTask(taskId: string, openid: string): Promise<void> {
  const now = Date.now();
  await getPool().execute(
    'INSERT INTO tasks (task_id, openid, status, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)',
    [taskId, openid, 'pending', now, now]
  );
}

/** 读取任务；超过 TTL（默认 10 分钟）视为已过期并顺带清理，返回 null */
export async function getTask(taskId: string, ttlMs = 10 * 60 * 1000) {
  const [rows] = await getPool().execute(
    'SELECT task_id, status, result, error, created_at FROM tasks WHERE task_id = ?',
    [taskId]
  ) as any;
  if (rows.length === 0) return null;

  const task = rows[0];
  if (Date.now() - Number(task.created_at) > ttlMs) {
    //过期任务顺手删掉，避免表膨胀
    getPool().execute('DELETE FROM tasks WHERE task_id = ?', [taskId]).catch(() => {});
    return null;
  }

  let result: any = null;
  if (task.result) {
    try {
      result = JSON.parse(task.result);
    } catch {
      result = null;
    }
  }
  return {
    id: task.task_id,
    status: task.status as TaskStatus,
    result,
    error: task.error || undefined,
    createdAt: Number(task.created_at),
  };
}

/** 更新任务状态与结果（result 为 undefined 时不覆盖，便于重试期间只改status） */
export async function updateTask(
  taskId: string,
  status: TaskStatus,
  fields: { result?: any; error?: string } = {}
): Promise<void> {
  const sets: string[] = ['status = ?', 'updated_at = ?'];
  const args: any[] = [status, Date.now()];
  if (fields.result !== undefined) {
    sets.push('result = ?');
    args.push(JSON.stringify(fields.result));
  }
  if (fields.error !== undefined) {
    sets.push('error = ?');
    args.push(fields.error);
  }
  args.push(taskId);
  await getPool().execute(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = ?`, args);
}

/** 清理过期任务（可由定时器或提交时顺带调用） */
export async function cleanupTasks(ttlMs = 10 * 60 * 1000): Promise<number> {
  const [res] = await getPool().execute(
    'DELETE FROM tasks WHERE created_at < ?',
    [Date.now() - ttlMs]
  ) as any;
  return res?.affectedRows || 0;
}

// ============================================================
// 三餐 AI 营养师业务操作（W2）
// ============================================================

export interface UserProfileInput {
  persona: 'takeout' | 'glycemic';
  height_cm?: number | null;
  weight_kg?: number | null;
  age?: number | null;
  gender?: 'male' | 'female' | null;
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active' | null;
  daily_kcal_low?: number | null;
  daily_kcal_high?: number | null;
  disclaimer_acknowledged?: boolean;
}

/** 保存/更新用户画像（upsert） */
export async function upsertUserProfile(userId: string, input: UserProfileInput) {
  const now = Date.now();
  await getPool().execute(
    `INSERT INTO user_profiles
       (user_id, persona, height_cm, weight_kg, age, gender, activity_level,
        daily_kcal_low, daily_kcal_high, disclaimer_acknowledged, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       persona = VALUES(persona), height_cm = VALUES(height_cm), weight_kg = VALUES(weight_kg),
       age = VALUES(age), gender = VALUES(gender), activity_level = VALUES(activity_level),
       daily_kcal_low = VALUES(daily_kcal_low), daily_kcal_high = VALUES(daily_kcal_high),
       disclaimer_acknowledged = VALUES(disclaimer_acknowledged), updated_at = VALUES(updated_at)`,
    [
      userId, input.persona,
      input.height_cm ?? null, input.weight_kg ?? null, input.age ?? null,
      input.gender ?? null, input.activity_level ?? 'light',
      input.daily_kcal_low ?? null, input.daily_kcal_high ?? null,
      input.disclaimer_acknowledged ? 1 : 0, now, now,
    ]
  );
  return getUserProfile(userId);
}

/** 读取用户画像（无记录返回 null） */
export async function getUserProfile(userId: string) {
  const [rows] = await getPool().execute('SELECT * FROM user_profiles WHERE user_id = ?', [userId]) as any;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    user_id: r.user_id,
    persona: r.persona,
    height_cm: r.height_cm != null ? Number(r.height_cm) : null,
    weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
    age: r.age,
    gender: r.gender,
    activity_level: r.activity_level,
    daily_kcal_low: r.daily_kcal_low,
    daily_kcal_high: r.daily_kcal_high,
    disclaimer_acknowledged: r.disclaimer_acknowledged === 1,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

export interface DietLogInput {
  log_date: string; // YYYY-MM-DD
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  persona: 'takeout' | 'glycemic';
  /** ⚠️ 保留字段但不使用：产品决策为「图片不落库」，见 insertDietLog 注释 */
  image_url?: string;
  dishes: any[];
  kcal_low: number | null;
  kcal_high: number | null;
  protein_low: number | null;
  protein_high: number | null;
  carb_low: number | null;
  carb_high: number | null;
  fat_low: number | null;
  fat_high: number | null;
  fiber_low: number | null;
  fiber_high: number | null;
  meal_score: number | null;
  suggestion: string | null;
  glycemic_risk: string | null;
  /** AI 解读补充字段（2026-10-17）：亮点/警示/控糖说明 */
  highlights?: string[] | null;
  warnings?: string[] | null;
  gi_notes?: string | null;
  meal_order_tip?: string | null;
}

/**
 * 插入一条饮食记录
 *
 * ⚠️ **图片不落库（2026-10-17 产品决策）**：
 *   只写入 AI 给出的建议与估算数据（菜品/热量/营养素/评分/建议）。
 *   image_url 一律写空字符串，即使 input 带了值也不落库 ——
 *   用户餐食照片属隐私信息，从源头杜绝存储可消除泄露风险。
 */
export async function insertDietLog(userId: string, input: DietLogInput): Promise<number> {
  const [res] = await getPool().execute(
    `INSERT INTO diet_logs
       (user_id, log_date, meal_type, image_url, persona, dishes_json,
        kcal_low, kcal_high, protein_low, protein_high, carb_low, carb_high,
        fat_low, fat_high, fiber_low, fiber_high, meal_score, suggestion, glycemic_risk,
        highlights_json, warnings_json, gi_notes, meal_order_tip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, input.log_date, input.meal_type, '', input.persona,
      JSON.stringify(input.dishes || []),
      input.kcal_low, input.kcal_high,
      input.protein_low, input.protein_high, input.carb_low, input.carb_high,
      input.fat_low, input.fat_high, input.fiber_low, input.fiber_high,
      input.meal_score, input.suggestion, input.glycemic_risk,
      // AI 解读补充字段：空数组存'[]' 而非 NULL，前端可直接遍历
      JSON.stringify(input.highlights || []),
      JSON.stringify(input.warnings || []),
      input.gi_notes || null,
      input.meal_order_tip || null,
      Date.now(),
    ]
  ) as any;
  return res.insertId;
}

function fmtDate(v: any): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** 读取某日全部饮食记录（按创建时间排序） */
export async function getDietLogsByDate(userId: string, logDate: string) {
  const [rows] = await getPool().execute(
    'SELECT * FROM diet_logs WHERE user_id = ? AND log_date = ? ORDER BY created_at ASC',
    [userId, logDate]
  ) as any;
  return rows.map((r: any) => ({
    id: r.id,
    log_date: fmtDate(r.log_date),
    meal_type: r.meal_type,
    image_url: r.image_url || '',
    persona: r.persona,
    dishes: (() => { try { return JSON.parse(r.dishes_json || '[]'); } catch { return []; } })(),
    kcal_low: r.kcal_low, kcal_high: r.kcal_high,
    protein_low: r.protein_low, protein_high: r.protein_high,
    carb_low: r.carb_low, carb_high: r.carb_high,
    fat_low: r.fat_low, fat_high: r.fat_high,
    fiber_low: r.fiber_low, fiber_high: r.fiber_high,
    meal_score: r.meal_score,
    suggestion: r.suggestion,
    glycemic_risk: r.glycemic_risk,
    highlights: (() => { try { return JSON.parse(r.highlights_json || '[]'); } catch { return []; } })(),
    warnings: (() => { try { return JSON.parse(r.warnings_json || '[]'); } catch { return []; } })(),
    gi_notes: r.gi_notes,
    meal_order_tip: r.meal_order_tip,
    created_at: Number(r.created_at),
  }));
}

/**
 * 查询日期区间内有饮食记录的日期列表（打卡日历用）
 *
 * 只返回「至少有一条记录」的日期，避免把明细全查出来再过滤。
 * 打卡绿点以此为准 —— 服务端是唯一数据源，本地 storage 仅作离线兜底。
 */
export async function getDietLogDaysInRange(
  userId: string,
  from: string,
  to: string
): Promise<string[]> {
  const [rows] = await getPool().execute(
    `SELECT DISTINCT log_date FROM diet_logs
      WHERE user_id = ? AND log_date BETWEEN ? AND ?
      ORDER BY log_date ASC`,
    [userId, from, to]
  ) as any;
  return rows.map((r: any) => fmtDate(r.log_date));
}

/** 体重记录（同一天重复则覆盖） */
export async function upsertWeightLog(userId: string, logDate: string, weightKg: number) {
  await getPool().execute(
    `INSERT INTO weight_logs (user_id, log_date, weight_kg, created_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`,
    [userId, logDate, weightKg, Date.now()]
  );
}

/** 体重曲线数据点（按日期升序，最近 N 天） */
export async function getWeightLogs(userId: string, days: number) {
  const [rows] = await getPool().execute(
    'SELECT log_date, weight_kg FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT ?',
    [userId, days]
  ) as any;
  return rows
    .map((r: any) => ({ log_date: fmtDate(r.log_date), weight_kg: Number(r.weight_kg) }))
    .reverse();
}


/** 删除某用户某日某餐位的全部记录（早/午/晚餐多次记录时自动删除前次） */
export async function deleteDietLogsByDateMeal(userId: string, logDate: string, mealType: string) {
  const [res] = await getPool().execute(
    'DELETE FROM diet_logs WHERE user_id = ? AND log_date = ? AND meal_type = ?',
    [userId, logDate, mealType]
  ) as any;
  return res.affectedRows || 0;
}

/** 某餐位历史记录（按日期倒序，最近 N 天） */
/**
 * 某餐位的历史记录（含 AI 解读详情）
 *
 * 2026-10-17 扩展：除菜品与热量外，一并返回 AI 的建议、亮点、警示、
 * 控糖说明与进食顺序建议，供 history 页展开时展示完整诊断。
 */
export async function getDietLogHistory(userId: string, mealType: string, days: number) {
  const [rows] = await getPool().execute(
    `SELECT id, log_date, persona, dishes_json,
            kcal_low, kcal_high, meal_score, suggestion, glycemic_risk,
            highlights_json, warnings_json, gi_notes, meal_order_tip
       FROM diet_logs
      WHERE user_id = ? AND meal_type = ?
      ORDER BY log_date DESC
      LIMIT ?`,
    [userId, mealType, days]
  ) as any;
  return rows.map((r: any) => ({
    id: r.id,
    log_date: fmtDate(r.log_date),
    persona: r.persona || 'takeout',
    dishes: (() => { try { return JSON.parse(r.dishes_json || '[]'); } catch { return []; } })(),
    kcal_low: r.kcal_low, kcal_high: r.kcal_high,
    meal_score: r.meal_score,
    suggestion: r.suggestion || '',
    glycemic_risk: r.glycemic_risk,
    highlights: (() => { try { return JSON.parse(r.highlights_json || '[]'); } catch { return []; } })(),
    warnings: (() => { try { return JSON.parse(r.warnings_json || '[]'); } catch { return []; } })(),
    gi_notes: r.gi_notes || '',
    meal_order_tip: r.meal_order_tip || '',
  }));
}

// ============================================================
// 每日打卡提醒订阅
// ============================================================

/** 记录/更新订阅（重新授权后 used 重置为 0，允许当日再次发送） */
export async function upsertReminderSubscription(userId: string) {
  const now = Date.now();
  await getPool().execute(
    `INSERT INTO reminder_subscriptions (user_id, subscribed_at, used, updated_at)
     VALUES (?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE used = 0, updated_at = VALUES(updated_at)`,
    [userId, now, now]
  );
}

/** 当日提醒候选：已订阅(used=0) 且当日无任何饮食记录的用户 */
export async function getReminderCandidates(logDate: string) {
  const [rows] = await getPool().execute(
    `SELECT rs.user_id FROM reminder_subscriptions rs
     WHERE rs.used = 0 AND NOT EXISTS (
       SELECT 1 FROM diet_logs dl WHERE dl.user_id = rs.user_id AND dl.log_date = ?
     )`,
    [logDate]
  ) as any;
  return rows.map((r: any) => r.user_id as string);
}

/** 标记已发送（当日不再重复提醒） */
export async function markReminderUsed(userId: string) {
  await getPool().execute(
    'UPDATE reminder_subscriptions SET used = 1, updated_at = ? WHERE user_id = ?',
    [Date.now(), userId]
  );
}

/** 每天定时任务开始时重置（新的一天重新允许发送） */
export async function resetReminderUsed() {
  await getPool().execute('UPDATE reminder_subscriptions SET used = 0');
}
