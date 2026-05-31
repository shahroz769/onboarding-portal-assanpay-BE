const DEFAULT_CASE_SLA_HOURS = 24

export function isCaseSlaBreached({
  createdAt,
  evaluatedAt,
  slaHours,
}: {
  createdAt: Date | string
  evaluatedAt: Date | string
  slaHours: number | null | undefined
}) {
  const effectiveSlaHours =
    typeof slaHours === 'number' && slaHours > 0
      ? slaHours
      : DEFAULT_CASE_SLA_HOURS

  const createdTime = new Date(createdAt).getTime()
  const evaluatedTime = new Date(evaluatedAt).getTime()
  const deadlineTime = createdTime + effectiveSlaHours * 60 * 60 * 1000

  return evaluatedTime > deadlineTime
}