import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Journal = {
  entries: Array<{ tag: string }>
}

const migrationsDirectory = new URL('../drizzle/', import.meta.url)
const journalFile = Bun.file(new URL('meta/_journal.json', migrationsDirectory))
const journal = (await journalFile.json()) as Journal
const journalTags = journal.entries.map((entry) => entry.tag)
const journalTagSet = new Set(journalTags)

const legacyUnjournaledFiles = new Set([
  '0005_cases_priority',
  '0007_notifications',
  '0008_resubmission_and_email',
  '0027_physical_agreement_queue',
])

const migrationFiles = readdirSync(fileURLToPath(migrationsDirectory))
  .filter((file) => file.endsWith('.sql'))
  .map((file) => file.replace(/\.sql$/, ''))
  .filter((tag) => !tag.startsWith('seed-'))

const duplicateTags = journalTags.filter(
  (tag, index) => journalTags.indexOf(tag) !== index,
)
const missingFiles = journalTags.filter((tag) => !migrationFiles.includes(tag))
const unjournaledFiles = migrationFiles.filter(
  (tag) => !journalTagSet.has(tag) && !legacyUnjournaledFiles.has(tag),
)

const missingLegacyFiles = Array.from(legacyUnjournaledFiles).filter(
  (tag) => !migrationFiles.includes(tag),
)

if (
  duplicateTags.length ||
  missingFiles.length ||
  unjournaledFiles.length ||
  missingLegacyFiles.length
) {
  console.error('Drizzle migration history is inconsistent.')
  if (duplicateTags.length) console.error('Duplicate journal tags:', duplicateTags)
  if (missingFiles.length) console.error('Journal entries without SQL:', missingFiles)
  if (unjournaledFiles.length) {
    console.error('SQL files absent from the journal:', unjournaledFiles)
  }
  if (missingLegacyFiles.length) {
    console.error('Documented legacy SQL files are missing:', missingLegacyFiles)
  }
  process.exit(1)
}

console.log(`Migration history is consistent (${journalTags.length} migrations).`)
