/**
 * temp-image-store.ts — 临时图片托管（为第三方 AI 接口提供公网可访问的 ImageURL）
 * ============================================================
 * 背景（2026-10-13，审核要求拦截公众人物与明星）：
 *   阿里云 RecognizePublicFace / DetectCelebrity 需要图片以**公网可访问
 *   的 URL** 传入（ImageURL 字段），而 Base64 直传在原理上不可行：
 *     图片 → Base64 膨胀 1.33倍 → URL 编码再涨 ~25%
 *     100KB 图片 → URL 约 167KB，而网关限制约 8KB
 *     即便压到 5KB（48×48 像素）仍超限，且已无识图意义。
 *
 *   微信官方 media_check_async 同样要求 media_url 为可下载的公网地址，
 *   故本模块**同时服务于两个需求**。
 *
 * 方案：**用本服务自身作为图片托管**（无需引入 COS/OSS）。
 *   小程序上传图片 → 后端落盘到临时目录 → 返回
 *   https://api.aivibeshot.com.cn/api/tmp-img/<token>
 *   第三方AI 直接下载该地址 → 识别完成后自动删除。
 *
 * 安全设计（⚠️ 处理用户上传的图片，务必注意）：
 *   1. **token 为强随机**（32 位 hex），不可枚举、不可猜测
 *   2. **短TTL**（默认 10 分钟），过期自动清理，防止磁盘堆积
 *   3. **立即过期**的类型标注，不提供长期可访问的图片
 *      （避免成为图床/隐私泄露源）
 *   4. **只允许 GET/HEAD**，不支持写入以外的任何方法
 *   5. **不暴露原始文件名与用户信息**，路径仅含 token
 *   6. **定期清理**（每5 分钟扫一次过期文件）
 *
 * 适用前提：云托管需为**单实例或有持久化磁盘**。
 *   多实例场景下若实例间不共享文件系统，需改为 COS/OSS（见下方说明）。
 * ============================================================
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 临时图片目录（挂到系统临时目录，避免污染项目目录） */
const TMP_DIR = process.env.TMP_IMAGE_DIR
  ? path.resolve(process.env.TMP_IMAGE_DIR)
  : path.join(os.tmpdir(), 'vibeshot-tmp-img');

/** 单个文件的 TTL（毫秒），默认 10 分钟 */
const TTL_MS = Number(process.env.TMP_IMAGE_TTL_MS || 10 * 60 * 1000);

/** 单文件大小上限（字节），默认 10MB —— 与微信内容安全接口一致 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 允许的图片 MIME 类型 */
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
};

let inited = false;

/** 确保目录存在（幂等） */
function ensureDir(): void {
  if (inited) return;
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  inited = true;
}

/** token → { path, mime, expireAt } */
type Meta = { filePath: string; mime: string; expireAt: number };
const metaMap = new Map<string, Meta>();

// 定期清理过期文件
let lastSweep = Date.now();
function sweep(): void {
  const now = Date.now();
  // 每 3 分钟扫一次
  if (now - lastSweep < 3 * 60 * 1000) return;
  lastSweep = now;
  for (const [token, m] of metaMap) {
    if (m.expireAt <= now) {
      removeOne(token);
      continue;
    }
  }
  // 兜底：清理目录中不在 meta 里的孤儿文件（如进程重启遗留）
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (!f.endsWith('.img')) continue;
      const token = f.replace(/\.img$/, '');
      if (!metaMap.has(token)) {
        try {
          fs.unlinkSync(path.join(TMP_DIR, f));
        } catch {
          /* 忽略：文件可能已被删除 */
        }
      }
    }
  } catch {
    /* 目录不存在时忽略 */
  }
}

function removeOne(token: string): void {
  const m = metaMap.get(token);
  if (!m) return;
  metaMap.delete(token);
  try {
    if (fs.existsSync(m.filePath)) fs.unlinkSync(m.filePath);
  } catch {
    /* 忽略 */
  }
}

/**
 * 保存一张临时图片，返回访问 token。
 *
 * @param base64 图片 Base64（不含 data URI 前缀）
 * @param mime   MIME 类型，默认 image/jpeg
 * @returns token；失败返回 null（调用方应降级，不阻断主流程）
 */
export function saveTempImage(base64: string, mime = 'image/jpeg'): string | null {
  try {
    ensureDir();

    const cleanMime = String(mime).toLowerCase();
    if (!ALLOWED_MIME[cleanMime]) {
      console.warn(`[临时图片] 不支持的类型: ${cleanMime}`);
      return null;
    }

    // 去掉可能的 data URI 前缀
    let b64 = String(base64 || '');
    if (b64.startsWith('data:')) {
      const i = b64.indexOf(',');
      if (i >= 0) b64 = b64.slice(i + 1);
    }
    if (!b64) return null;

    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    if (buf.length > MAX_FILE_BYTES) {
      console.warn(`[临时图片] 体积超限: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
      return null;
    }

    // 强随机 token，不可枚举
    const token = crypto.randomBytes(16).toString('hex');
    const filePath = path.join(TMP_DIR, `${token}.img`);
    fs.writeFileSync(filePath, buf, { mode: 0o600 });

    metaMap.set(token, { filePath, mime: cleanMime, expireAt: Date.now() + TTL_MS });
    sweep();
    return token;
  } catch (e: any) {
    console.warn('[临时图片] 保存失败:', e?.message);
    return null;
  }
}

/**
 * 读取一张临时图片。
 * @returns { buffer, mime } | null（不存在或已过期返回 null）
 */
export function readTempImage(token: string): { buffer: Buffer; mime: string } | null {
  sweep();
  // ⚠️ token 只允许 hex，防止路径穿越（如 ../../etc/passwd）
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  const m = metaMap.get(token);
  if (!m) return null;
  if (m.expireAt <= Date.now()) {
    removeOne(token);
    return null;
  }
  try {
    if (!fs.existsSync(m.filePath)) return null;
    return { buffer: fs.readFileSync(m.filePath), mime: m.mime };
  } catch {
    return null;
  }
}

/**
 * 用公网基础地址拼出完整 URL，供阿里云/微信下载。
 * @param baseUrl 如 https://api.aivibeshot.com.cn
 */
export function buildTempImageUrl(baseUrl: string, token: string): string {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/tmp-img/${token}`;
}

/** 主动删除（识别完成后调用，加快清理） */
export function deleteTempImage(token: string): void {
  removeOne(token);
}

/** 启动自检 */
export function describeConfig(): string {
  ensureDir();
  return `临时图片目录=${TMP_DIR} TTL=${Math.round(TTL_MS / 1000)}s 当前=${metaMap.size}张`;
}
