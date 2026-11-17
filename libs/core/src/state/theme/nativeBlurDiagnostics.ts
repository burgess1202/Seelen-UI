interface NativeBlurRuntime {
  __SLU_NATIVE_BLUR_TRACE__?: boolean;
  __SLU_NATIVE_BLUR_EARLY_EXIT__?: boolean;
  __SLU_NATIVE_BLUR_WINDOW__?: string;
}

export function nativeBlurTraceEnabled(): boolean {
  return (globalThis as NativeBlurRuntime).__SLU_NATIVE_BLUR_TRACE__ === true;
}

export function nativeBlurEarlyExit(): boolean {
  return (globalThis as NativeBlurRuntime).__SLU_NATIVE_BLUR_EARLY_EXIT__ !== false;
}

/** API/JS observations only. These events never claim GPU/DWM presentation completion. */
export function traceNativeBlur(stage: string, detail: Record<string, unknown>): void {
  if (!nativeBlurTraceEnabled()) return;
  try {
    console.info(
      "NATIVE_BLUR_TIMELINE",
      JSON.stringify({
        stage,
        wallMs: performance.timeOrigin + performance.now(),
        document: globalThis.location?.pathname,
        window: (globalThis as NativeBlurRuntime).__SLU_NATIVE_BLUR_WINDOW__,
        ...detail,
      }),
    );
  } catch { /* Diagnostics must never prevent show/hide or cleanup. */ }
}
