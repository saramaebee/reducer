/** Structured error reporting, loaded lazily so the happy path never pays for it. */
export async function reportError(err: unknown): Promise<Record<string, unknown>> {
  const { serializeError } = await import('serialize-error');
  const { parse } = await import('stacktrace-parser');
  const serialized = serializeError(err) as { message?: string; code?: string; stack?: string };
  const frames = parse(serialized.stack ?? '').slice(0, 3);
  return {
    error: serialized.message ?? 'unknown',
    code: serialized.code ?? null,
    frameCount: frames.length,
    topFrameMethod: frames[0]?.methodName ?? null,
  };
}
