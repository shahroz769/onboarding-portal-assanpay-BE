import { env } from '../config/env'
import { AppError } from './errors'

// AES-256-GCM for short secrets that must be read back later (so hashing is
// not an option). Stored as `v1.<iv>.<ciphertext>` in base64url. The
// associated data binds a ciphertext to its row, so it cannot be copied onto
// another record and decrypted there.
const VERSION = 'v1'

// Each kind of secret has its own key, so one leaked key exposes one kind.
export type SecretKeyName =
  | 'PORTAL_PASSWORD_ENCRYPTION_KEY'
  | 'PORTAL_API_CREDENTIALS_ENCRYPTION_KEY'

const SECRET_KEY_LABELS: Record<SecretKeyName, string> = {
  PORTAL_PASSWORD_ENCRYPTION_KEY: 'Portal password encryption',
  PORTAL_API_CREDENTIALS_ENCRYPTION_KEY: 'Portal API credential encryption',
}

const cachedKeys = new Map<SecretKeyName, Promise<CryptoKey>>()

function getKey(keyName: SecretKeyName) {
  const rawKey = env[keyName]
  if (!rawKey) {
    throw new AppError(
      500,
      `${SECRET_KEY_LABELS[keyName]} is not configured. Set ${keyName}.`,
    )
  }
  let key = cachedKeys.get(keyName)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      Buffer.from(rawKey, 'base64'),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
    cachedKeys.set(keyName, key)
  }
  return key
}

export async function encryptSecret(
  plaintext: string,
  associatedData: string,
  keyName: SecretKeyName = 'PORTAL_PASSWORD_ENCRYPTION_KEY',
) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(associatedData),
    },
    await getKey(keyName),
    new TextEncoder().encode(plaintext),
  )
  return [
    VERSION,
    Buffer.from(iv).toString('base64url'),
    Buffer.from(ciphertext).toString('base64url'),
  ].join('.')
}

export async function decryptSecret(
  sealed: string,
  associatedData: string,
  keyName: SecretKeyName = 'PORTAL_PASSWORD_ENCRYPTION_KEY',
) {
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
      await getKey(keyName),
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
