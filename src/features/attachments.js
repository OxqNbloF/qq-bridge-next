// 附件与图片安全嗅探（零原生依赖解析 PNG/JPEG/GIF/WebP 宽高与像素炸弹校验）
import http from 'node:http';
import https from 'node:https';
import { validatePublicUrl } from '../security/safe-fetch.js';

export function detectImageHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.length >= 24) {
    return { format: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  const head6 = buf.subarray(0, 6).toString('ascii');
  if ((head6 === 'GIF87a' || head6 === 'GIF89a') && buf.length >= 10) {
    return { format: 'gif', mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      return {
        format: 'webp',
        mime: 'image/webp',
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    return { format: 'webp', mime: 'image/webp', width: 0, height: 0 };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return { format: 'jpeg', mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return { format: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

export function checkImageBuffer(buf, { maxBytes = 3145728, maxPixels = 16777216 } = {}) {
  if (!Buffer.isBuffer(buf)) return { ok: false, error: '无效图片二进制' };
  if (buf.length > maxBytes) return { ok: false, error: `图片大小 ${buf.length}B 超出上限 ${maxBytes}B` };
  const info = detectImageHeader(buf);
  if (!info) return { ok: false, error: '不支持或损坏的图片签名' };
  const pixels = info.width * info.height;
  if (pixels > maxPixels) return { ok: false, error: `图片像素 ${info.width}x${info.height} 超出上限 ${maxPixels}` };
  return { ok: true, ...info, bytes: buf.length, pixels };
}

export async function inspectRemoteImage(urlString, { maxBytes = 3145728, maxPixels = 16777216, timeoutMs = 15000 } = {}) {
  const { url, address, family } = await validatePublicUrl(urlString);
  const isHttps = url.protocol === 'https:';
  const requester = isHttps ? https.request : http.request;

  const buf = await new Promise((resolve, reject) => {
    const req = requester({
      host: address,
      family,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Host: url.host, 'User-Agent': 'chat-relay-attach/1.0' },
      ...(isHttps ? { servername: url.hostname } : {}),
    }, (resp) => {
      const chunks = [];
      let total = 0;
      resp.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          resp.destroy();
          reject(new Error(`图片体积超过上限 ${maxBytes}B`));
          return;
        }
        chunks.push(chunk);
      });
      resp.on('end', () => resolve(Buffer.concat(chunks)));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('inspectRemoteImage 超时')));
    req.end();
  });

  return checkImageBuffer(buf, { maxBytes, maxPixels });
}
