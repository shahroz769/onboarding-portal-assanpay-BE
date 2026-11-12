/** Longest name stored (the original_name columns are varchar(255)). */
export const MAX_UPLOAD_FILE_NAME_LENGTH = 255

// Code point ranges removed from names: C0/C1 control characters, and the
// bidirectional controls (e.g. U+202E, right-to-left override) that can make
// "invoice<U+202E>fdp.exe" display as "invoiceexe.pdf". Kept as numbers so
// no invisible character ever appears in this file.
const UNSAFE_CODE_POINT_RANGES: Array<[number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x061c, 0x061c], // Arabic letter mark
  [0x200e, 0x200f], // left-to-right / right-to-left marks
  [0x202a, 0x202e], // embeddings and overrides
  [0x2066, 0x2069], // isolates
]

function isUnsafeCodePoint(codePoint: number) {
  return UNSAFE_CODE_POINT_RANGES.some(
    ([from, to]) => codePoint >= from && codePoint <= to,
  )
}

/**
 * The name an upload is stored and shown under: no control or direction
 * characters, no path separators, trimmed, and at most 255 characters with
 * the extension kept. Falls back when nothing usable is left.
 */
export function cleanUploadFileName(name: string, fallback = 'upload') {
  const cleaned = Array.from(name.normalize('NFC'))
    .filter((character) => !isUnsafeCodePoint(character.codePointAt(0) ?? 0))
    .join('')
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // A name made only of dots ("..") is not a usable file name.
    .replace(/^\.+$/, '')

  if (!cleaned) return fallback
  if (cleaned.length <= MAX_UPLOAD_FILE_NAME_LENGTH) return cleaned

  const dot = cleaned.lastIndexOf('.')
  const extension =
    dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : ''
  return (
    cleaned.slice(0, MAX_UPLOAD_FILE_NAME_LENGTH - extension.length).trimEnd() +
    extension
  )
}
