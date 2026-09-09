/** Reduces any thrown/rejected value to a display-safe message string. */
export function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
