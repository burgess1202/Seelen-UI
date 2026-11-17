import { debounce } from "../../../utils/async.ts";
import { Widget_3 } from "./3_autosize.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  beginNativeBlurClose,
  finishNativeBlurClose,
  nativeBlurContext,
  resumeNativeBlur,
} from "../../theme/nativeBlur.ts";
import { nativeBlurTraceEnabled, traceNativeBlur } from "../../theme/nativeBlurDiagnostics.ts";
import {
  captureHideAnimations,
  collectHideAnimations,
  hideAnimationBudget,
  waitHideAnimations,
} from "./hideAnimations.ts";

/** Max time given to widgets to play their hide animation before the window is really hidden */
const HIDE_ANIMATION_MAX_MS = 200;

const debouncedClose = debounce(async () => {
  const window = getCurrentWindow();
  // safety net, never close a window that the user is looking at
  if (!(await window.isVisible())) {
    await window.close();
  }
}, 30_000);

export class Widget_4 extends Widget_3 {
  protected _destroyOnHide = false;
  /**
   * Incremented on every show/hide call, so any in-flight call can detect it was superseded
   * by a newer one after each `await` and bail out.
   */
  private _visibilityToken = 0;
  private _hideOperation?: { token: number; promise: Promise<void> };

  private traceVisibility(stage: string, token: number): void {
    if (!nativeBlurTraceEnabled()) return;
    const detail = { ...nativeBlurContext(), token, window: this.window.label };
    traceNativeBlur(stage, detail);
    // An asynchronous API observation, not a compositor/pixel completion fence.
    void this.window.isVisible().then((visible) => {
      traceNativeBlur(`${stage}.hwnd.query.ack`, { ...detail, visible });
    }).catch((error) => traceNativeBlur(`${stage}.hwnd.query.error`, { ...detail, error: String(error) }));
  }

  public async show(): Promise<void> {
    const token = ++this._visibilityToken;
    debouncedClose.cancel();
    resumeNativeBlur();
    this.traceVisibility("widget.show.call", token);
    await this.window.show();
    this.traceVisibility("widget.show.api.ack", token);
    // a hide() was called while showing, it already owns the attribute.
    if (token === this._visibilityToken) {
      delete globalThis.document.documentElement.dataset.widgetHidden;
    }
  }

  public hide(): Promise<void> {
    if (this._hideOperation?.token === this._visibilityToken) return this._hideOperation.promise;
    const token = ++this._visibilityToken;
    const promise = this.performHide(token).finally(() => {
      if (this._hideOperation?.token === token) this._hideOperation = undefined;
    });
    this._hideOperation = { token, promise };
    return promise;
  }

  private async performHide(token: number): Promise<void> {
    this.traceVisibility("widget.hide.intent", token);
    const before = captureHideAnimations(globalThis.document.getAnimations());
    // Default policy exits native blur before requesting the HTML close animation.
    // No native ACK is awaited. The legacy gate remains available for controlled A/B.
    const close = beginNativeBlurClose(HIDE_ANIMATION_MAX_MS, () => {
      globalThis.document.documentElement.dataset.widgetHidden = "";
    });
    const animations = collectHideAnimations(before, globalThis.document.getAnimations());
    const budget = hideAnimationBudget(animations, HIDE_ANIMATION_MAX_MS);
    // Normal completion follows animation.finished; the native deadline is only the watchdog.
    // Never use nominal CSS duration as a hard deadline: its timeline may lag wall-clock time.
    // IPC is never a prerequisite to HWND hide.
    if (nativeBlurTraceEnabled()) {
      const detail = { ...nativeBlurContext(), token, budget, count: animations.length };
      traceNativeBlur("animation.close.requested", detail);
      for (const animation of animations) {
        void animation.ready.then(() => traceNativeBlur("animation.close.ready", detail)).catch(() => {});
        void animation.finished.then(() => traceNativeBlur("animation.close.finished", detail))
          .catch(() => traceNativeBlur("animation.close.cancelled", detail));
      }
    }
    const completion = await waitHideAnimations(animations, budget);
    if (nativeBlurTraceEnabled()) {
      traceNativeBlur("animation.wait.complete", { ...nativeBlurContext(), token, completion });
    }
    if (token !== this._visibilityToken) {
      return;
    }
    this.traceVisibility("widget.hide.call", token);
    const hidden = this.window.hide();
    finishNativeBlurClose(close);
    await hidden;
    this.traceVisibility("widget.hide.api.ack", token);
    // a show() may have been called while the window was hiding, don't schedule the close.
    if (this._destroyOnHide && token === this._visibilityToken) {
      debouncedClose();
    }
  }
}
