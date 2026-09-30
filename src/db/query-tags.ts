import { AsyncLocalStorage } from 'node:async_hooks'

import type postgres from 'postgres'

import { env } from '../config/env'

// SQLCommenter tags let PlanetScale Insights attribute queries to a route or
// background job. Values must stay low-cardinality: route templates and job
// names only, never raw paths, ids, emails or tokens.
export type QueryTags = {
  route?: string
  job?: string
}

const queryTagStorage = new AsyncLocalStorage<QueryTags>()

export function withQueryTags<T>(tags: QueryTags, fn: () => T): T {
  return queryTagStorage.run(tags, fn)
}

function encodeTagValue(value: string) {
  return encodeURIComponent(value).replaceAll("'", "\\'")
}

function queryTagComment() {
  const tags: Record<string, string | undefined> = {
    application: 'onboarding-portal-be',
    release_sha: env.RELEASE_SHA,
    ...queryTagStorage.getStore(),
  }

  // The spec orders keys lexicographically.
  const pairs = Object.keys(tags)
    .filter((key) => tags[key])
    .sort()
    .map((key) => `${key}='${encodeTagValue(tags[key] as string)}'`)

  return `/*${pairs.join(',')}*/`
}

function tagQuery(query: string) {
  const trimmed = query.trimEnd()
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
  return `${body} ${queryTagComment()}`
}

type Sql = postgres.Sql<Record<string, never>>
type Callback = (sql: Sql) => unknown

// Drizzle's postgres-js session only issues queries through unsafe(), and
// hands begin()/savepoint() callbacks a new client, so those are wrapped too.
export function withSqlCommenter<T extends Sql>(client: T): T {
  const wrapCallbackArgs = (args: unknown[]) =>
    args.map((arg) =>
      typeof arg === 'function'
        ? (sql: Sql) => (arg as Callback)(withSqlCommenter(sql))
        : arg,
    )

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'unsafe') {
        return (query: string, ...rest: unknown[]) =>
          (target.unsafe as (...args: unknown[]) => unknown)(
            tagQuery(query),
            ...rest,
          )
      }
      if (property === 'begin' || property === 'savepoint') {
        const method = Reflect.get(target, property, receiver) as (
          ...args: unknown[]
        ) => unknown
        return (...args: unknown[]) =>
          method.apply(target, wrapCallbackArgs(args))
      }
      return Reflect.get(target, property, receiver)
    },
  })
}
