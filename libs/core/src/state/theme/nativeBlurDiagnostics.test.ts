import { assertEquals } from "@std/assert";
import { nativeBlurEarlyExit, nativeBlurTraceEnabled, traceNativeBlur } from "./nativeBlurDiagnostics.ts";

Deno.test("diagnostics default off and early exit default on; runtime flags permit A/B", () => {
  const runtime = globalThis as typeof globalThis & {
    __SLU_NATIVE_BLUR_TRACE__?: boolean;
    __SLU_NATIVE_BLUR_EARLY_EXIT__?: boolean;
  };
  const trace = runtime.__SLU_NATIVE_BLUR_TRACE__, early = runtime.__SLU_NATIVE_BLUR_EARLY_EXIT__;
  const original = console.info, events: unknown[][] = [];
  try {
    delete runtime.__SLU_NATIVE_BLUR_TRACE__;
    delete runtime.__SLU_NATIVE_BLUR_EARLY_EXIT__;
    console.info = (...args: unknown[]): void => {
      events.push(args);
    };
    assertEquals(nativeBlurTraceEnabled(), false);
    assertEquals(nativeBlurEarlyExit(), true);
    traceNativeBlur("test", {});
    assertEquals(events.length, 0);
    runtime.__SLU_NATIVE_BLUR_TRACE__ = true;
    runtime.__SLU_NATIVE_BLUR_EARLY_EXIT__ = false;
    assertEquals(nativeBlurEarlyExit(), false);
    traceNativeBlur("api.ack", { requestId: "1:geometry:2:3" });
    assertEquals(events.length, 1);
    const record = JSON.parse(String(events[0][1]));
    assertEquals(record.stage, "api.ack");
    assertEquals(record.requestId, "1:geometry:2:3");
    console.info = (): void => { throw new Error("injected log failure"); };
    // A broken diagnostic sink must not affect the caller's lifecycle operation.
    traceNativeBlur("widget.hide.call", { token: 1 });
  } finally {
    console.info = original;
    if (trace === undefined) delete runtime.__SLU_NATIVE_BLUR_TRACE__;
    else runtime.__SLU_NATIVE_BLUR_TRACE__ = trace;
    if (early === undefined) delete runtime.__SLU_NATIVE_BLUR_EARLY_EXIT__;
    else runtime.__SLU_NATIVE_BLUR_EARLY_EXIT__ = early;
  }
});
