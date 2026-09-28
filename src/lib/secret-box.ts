import { env } from '../config/env'
import { AppError } from './errors'

// AES-256-GCM for short secrets that must be read back later (so hashing is
// not an option). Stored as `v1.<iv>.<ciphertext>` in base64url. The
// associated data binds a ciphertext to its row, so it cannot be copied onto
// another record and decrypted there.
const VERSION = 'v1'

let cachedKey: Promise<CryptoKey> | undefined

function getKey() {
  const rawKey = env.PORTAL_PASSWORD_ENCRYPTION_KEY
  if (!rawKey) {
    throw new AppError(
      500,
      'Portal password encryption is not configured. Set PORTAL_PASSWORD_ENCRYPTION_KEY.',
    )
  }
  cachedKey ??= crypto.subtle.importKey(
    'raw',
    Buffer.from(rawKey, 'base64'),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
  return cachedKey
}

export async function encryptSecret(plaintext: string, associatedData: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(associatedData),
    },
    await getKey(),
    new TextEncoder().encode(plaintext),
  )
  return [
    VERSION,
    Buffer.from(iv).toString('base64url'),
    Buffer.from(ciphertext).toString('base64url'),
  ].join('.')
}

export async function decryptSecret(sealed: string, associatedData: string) {
  const [version, iv, ciphertext] = sealed.split('.')
  if (version !== VERSION || !iv || !ciphertext) {
    throw new AppError(500, 'Stored secret has an unknown format.')
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(iv, 'base64url'),
        additionalData: new TextEncoder().encode(associatedData),
      },
      await getKey(),
      Buffer.from(ciphertext, 'base64url'),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    throw new AppError(
      500,
      'Stored secret could not be decrypted. The encryption key may have changed.',
    )
  }
}
