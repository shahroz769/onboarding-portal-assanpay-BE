export type CaseFlowDependencyEdge = { from: string; to: string }

export function buildCaseFlowDependencyEdges(input: {
  closeTriggers: Array<{ sourceQueueId: string; targetQueueId: string }>
  creationRequirements: Array<{
    targetQueueId: string
    prerequisiteQueueId: string
  }>
  closeBlockers: Array<{
    blockedQueueId: string
    prerequisiteQueueId: string
  }>
}): CaseFlowDependencyEdge[] {
  return [
    ...input.closeTriggers.map((rule) => ({
      from: rule.targetQueueId,
      to: rule.sourceQueueId,
    })),
    ...input.creationRequirements.map((rule) => ({
      from: rule.targetQueueId,
      to: rule.prerequisiteQueueId,
    })),
    ...input.closeBlockers.map((rule) => ({
      from: rule.blockedQueueId,
      to: rule.prerequisiteQueueId,
    })),
  ]
}

export function findDependencyCycle(
  edges: CaseFlowDependencyEdge[],
): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  function dfs(node: string, path: string[]): string[] | null {
    if (visiting.has(node)) {
      const start = path.indexOf(node)
      return [...path.slice(start), node]
    }
    if (visited.has(node)) return null

    visiting.add(node)
    for (const next of adjacency.get(node) ?? []) {
      const cycle = dfs(next, [...path, node])
      if (cycle) return cycle
    }
    visiting.delete(node)
    visited.add(node)
    return null
  }

  for (const node of adjacency.keys()) {
    const cycle = dfs(node, [])
    if (cycle) return cycle
  }
  return null
}
