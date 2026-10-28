export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const safeError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError("internal", "Something went wrong. Please try again.", 500);
