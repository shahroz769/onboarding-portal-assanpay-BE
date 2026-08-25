/** PostgreSQL `text[]` type OID. */
export const TEXT_ARRAY_OID = 1009

function escapeArrayElement(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function serializePostgresTextArray(values: string[]) {
  if (values.length === 0) return '{}'
  return `{${values.map(escapeArrayElement).join(',')}}`
}

export function parsePostgresTextArray(raw: string) {
  if (raw === '{}') return []

  if (!raw.startsWith('{') || !raw.endsWith('}')) {
    throw new Error('Invalid PostgreSQL text[] value')
  }

  const inner = raw.slice(1, -1)
  if (!inner) return []

  const values: string[] = []
  let index = 0

  while (index < inner.length) {
    if (inner[index] === '"') {
      let value = ''
      index += 1
      while (index < inner.length) {
        if (inner[index] === '\\' && index + 1 < inner.length) {
          value += inner[index + 1]
          index += 2
          continue
        }
        if (inner[index] === '\\') {
          throw new Error('Invalid escape in PostgreSQL text[] value')
        }
        if (inner[index] === '"') {
          index += 1
          break
        }
        value += inner[index]
        index += 1
      }
      if (inner[index - 1] !== '"') {
        throw new Error('Unterminated quoted PostgreSQL text[] element')
      }
      values.push(value)
      if (index < inner.length && inner[index] !== ',') {
        throw new Error('Invalid PostgreSQL text[] delimiter')
      }
      if (inner[index] === ',') {
        index += 1
        if (index === inner.length) {
          throw new Error('PostgreSQL text[] value has a trailing delimiter')
        }
      }
      continue
    }

    let value = ''
    while (index < inner.length && inner[index] !== ',') {
      const character = inner[index]
      if (character === '{' || character === '}' || character === '"') {
        throw new Error('Unsupported PostgreSQL text[] structure')
      }
      if (character === '\\') {
        if (index + 1 >= inner.length) {
          throw new Error('Invalid escape in PostgreSQL text[] value')
        }
        value += inner[index + 1]
        index += 2
        continue
      }
      value += character
      index += 1
    }

    if (!value) throw new Error('Empty PostgreSQL text[] elements must be quoted')
    if (value.toUpperCase() === 'NULL') {
      throw new Error('NULL elements are not supported in application text[] values')
    }
    values.push(value)
    if (inner[index] === ',') {
      index += 1
      if (index === inner.length) {
        throw new Error('PostgreSQL text[] value has a trailing delimiter')
      }
    }
  }

  return values
}
