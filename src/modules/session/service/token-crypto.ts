import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM for refresh tokens stored in Postgres.
 * Key: TOKEN_ENCRYPTION_KEY = 32 random bytes, base64 encoded
 *   (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 * Stored format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>
 */
const VERSION = 'v1';

export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptToken(stored: string, key: Buffer): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error('Unsupported encrypted token format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
