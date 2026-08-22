import postgres from 'postgres'

type AuditIssue = {
  category: string
  detail: string
}

const directDatabaseUrl = Bun.env.DIRECT_DATABASE_URL

if (!directDatabaseUrl) {
  throw new Error(
    'DIRECT_DATABASE_URL is required for the read-only database audit.',
  )
}

const client = postgres(directDatabaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 5,
})

const expectedIndexes = [
  'cases_merchant_queue_idx',
  'cases_merchant_created_idx',
  'cases_open_merchant_idx',
  'cases_successful_flow_idx',
  'case_flow_close_jobs_pending_idx',
  'case_comments_case_created_idx',
  'case_history_case_action_created_idx',
  'case_history_case_created_idx',
  'merchants_active_priority_created_idx',
  'notifications_user_created_id_idx',
  'notifications_user_unread_created_id_idx',
]

try {
  const issues = await client<AuditIssue[]>`
    with duplicate_indexes as (
      select
        'duplicate_index'::text as category,
        format('%s and %s on %s',
          i1.indexrelid::regclass,
          i2.indexrelid::regclass,
          i1.indrelid::regclass
        ) as detail
      from pg_index i1
      join pg_index i2
        on i1.indrelid = i2.indrelid
       and i1.indexrelid < i2.indexrelid
       and i1.indisunique = i2.indisunique
       and i1.indkey = i2.indkey
       and i1.indclass = i2.indclass
       and i1.indcollation = i2.indcollation
       and i1.indoption = i2.indoption
       and pg_get_expr(i1.indexprs, i1.indrelid) is not distinct from
           pg_get_expr(i2.indexprs, i2.indrelid)
       and pg_get_expr(i1.indpred, i1.indrelid) is not distinct from
           pg_get_expr(i2.indpred, i2.indrelid)
      join pg_class table_class on table_class.oid = i1.indrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and i1.indisvalid
        and i2.indisvalid
    ),
    missing_fk_indexes as (
      select
        'missing_fk_index'::text as category,
        format('%s (%s)', constraint_row.conrelid::regclass, constraint_row.conname) as detail
      from pg_constraint constraint_row
      join pg_class table_class on table_class.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and constraint_row.contype = 'f'
        and not exists (
          select 1
          from pg_index index_row
          where index_row.indrelid = constraint_row.conrelid
            and index_row.indisvalid
            and (
              select array_agg(key_column order by position)
              from unnest(index_row.indkey::smallint[]) with ordinality
                as indexed_columns(key_column, position)
              where position <= cardinality(constraint_row.conkey)
            ) = constraint_row.conkey
        )
    ),
    invalid_constraints as (
      select
        'invalid_constraint'::text as category,
        format('%s (%s)', constraint_row.conrelid::regclass, constraint_row.conname) as detail
      from pg_constraint constraint_row
      join pg_class table_class on table_class.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and not constraint_row.convalidated
    ),
    missing_expected_indexes as (
      select
        'missing_expected_index'::text as category,
        expected.name as detail
      from unnest(${expectedIndexes}::text[]) as expected(name)
      where to_regclass('public.' || expected.name) is null
    )
    select * from duplicate_indexes
    union all
    select * from missing_fk_indexes
    union all
    select * from invalid_constraints
    union all
    select * from missing_expected_indexes
    order by category, detail
  `

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`[db:audit] ${issue.category}: ${issue.detail}`)
    }
    throw new Error(`Database audit found ${issues.length} issue(s).`)
  }

  console.log('Database audit passed.')
} finally {
  await client.end()
}
