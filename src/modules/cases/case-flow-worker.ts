type CaseFlowCloseJobDrainHandler = () => void

let drainHandler: CaseFlowCloseJobDrainHandler | null = null

export function setCaseFlowCloseJobDrainHandler(
  handler: CaseFlowCloseJobDrainHandler,
) {
  drainHandler = handler
}

export function requestCaseFlowCloseJobDrain() {
  drainHandler?.()
}
