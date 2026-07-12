export class AppError extends Error {
  statusCode: number
  details?: Record<string, unknown>

  constructor(
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.details = details
  }
}
