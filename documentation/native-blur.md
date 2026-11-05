# Experimental native background blur for themes

This community-nightly prototype draws `CreateBackdropBrush` + Direct2D Gaussian blur in a Windows
Composition target attached to the **existing Widget HWND**, below its transparent WebView2 child.
It does not create another window, intercept input, change Widget focus, or change WebView opacity.
The earlier isolated Win32 prototype verified rounded clips and loss of focus; that standalone
test panel has been removed. Native resource tests remain separate from production Widget windows.
The Widget/WebView2 integration still requires visual acceptance on the target machine; an IPC
acknowledgement proves resource creation, not that the backdrop pixels are correct on every GPU.
The shared page bootstrap starts the controller even for third-party Widgets bundled with an older
library. A document-level singleton prevents the Widget's own library from starting another copy.

## Implementation map

- `src/background/widgets/native_blur.rs`: per-Widget host, clipped visuals, resource reuse, document
  sessions, sequence checks, validation, disposal and native resource smoke tests.
- `src/background/widgets/native_blur_effect.rs`: backdrop/Gaussian effect and dispatcher used by
  the Widget renderer and native resource tests.
- `libs/core/src/state/theme/native_blur.rs` and `handlers/commands.rs`: typed region/clip payloads
  and generated Tauri commands. TypeScript command bindings are regenerated normally.
- `libs/core/src/state/theme/nativeBlur.ts`: one controller per document, discovery, observers,
  animation tracking, batching, fallback state and teardown.
- `libs/core/src/state/theme/nativeBlurGeometry.ts` and its test: CSS geometry and corner resolution.
- `src/ui/vanilla/entry-point/MainSetup.ts` and `libs/core/src/state/theme/theming.ts`: common Widget
  bootstrap and explicit theme-refresh integration, including older third-party Widget bundles.
- `src/background/widgets/webview.rs` and `mod.rs`: lifecycle registration and module wiring.
- `src/Cargo.toml`: enables Direct2D geometry bindings. Toolbar/Dock's old probe-only actions and
  `src/ui/svelte/nativeBlurPanel.ts` are replaced by the common opt-in controller. No default theme
  style is changed.

## CSS-only theme opt-in

Use an existing real element. Normal CSS determines its dimensions, position and border radius:

```css
/* Example only; these declarations are not installed into the default theme. */
.ft-bar {
  --slu-native-blur: 1;
  --slu-native-blur-amount: 18px;
  border-radius: 18px;
  background: rgb(20 24 32 / 25%);
  backdrop-filter: blur(18px); /* Optional fallback. */
}

.ft-bar[data-slu-native-blur-state="ready"] {
  backdrop-filter: none; /* Avoid applying both effects. */
}
```

`--slu-native-blur` is a registered, **non-inherited** numeric property: `1` enables, `0` disables.
It does not automatically enable descendants. `--slu-native-blur-amount` is an inherited CSS length,
defaulting to `18px`, clamped to `64px`; `0px` disables the region. The amount is Gaussian standard
deviation, not guaranteed to look identical to CSS `blur()` or Acrylic at the same number.

Widget authors can alternatively use `<div data-native-blur>...</div>`. An attribute value of
`"false"` disables that marker. Themes cannot create HTML attributes with CSS, so CSS-only themes
should use the custom property. The controller reads accessible stylesheets, inline declarations
and explicit markers; it never asks theme authors to invoke Rust themselves.

The controller reserves `data-slu-native-blur-state="ready"` on successfully submitted elements and
`data-slu-native-blur-status="ready|idle|unavailable"` on the document root. Keep a fallback unless
the individual element is ready. These attributes report successful native setup, not a pixel-level
proof that background sampling works. Do not use them to alter layout, the opt-in property, or
visibility, which would create a feedback loop. Unsupported geometry retains its CSS fallback.

## Supported geometry and synchronization

- One region per opted-in real `HTMLElement`, using its border box, all four independent elliptical
  border radii, and CSS's proportional normalization when corners overlap.
- Intersection with the viewport and clipping ancestors' padding boxes for `overflow: hidden`,
  `clip`, `auto`, or `scroll`. Ancestor borders, rounded corners and scrollbar space are accounted for.
- Axis-aligned positive scale and translation. Layout, resize, scroll, DOM attributes, theme reloads,
  CSS transitions/animations of the element or its ancestors, and document visibility changes trigger
  updates. `devicePixelRatio` converts CSS coordinates to Composition pixels.
- The element/ancestor opacity product controls only its native background visual. The controller
  does not rewrite original element opacity, pointer events, visibility or backgrounds.
- Focus is deliberately absent from the effect lifecycle: losing focus does not disable the brush.
  A hidden Widget hides the native layer with its existing HWND. Removing all regions releases the
  host. Navigation and destruction invalidate the document session and release all resources.
- IPC is scoped to the calling WebView; no arbitrary HWND is accepted. Session and sequence numbers
  reject requests left over from a previous document or superseded updates.

## MVP limitations

- **Native backgrounds are below all HTML**, not interleaved with arbitrary DOM stacking contexts.
  Opaque HTML backgrounds cover them. A native blur cannot sample another HTML element as though
  it were CSS `backdrop-filter`. Avoid overlapping/nested native regions: their blur can compound.
- Rotation, skew, perspective, negative scale, multi-line fragmented inline boxes, CSS `clip-path`,
  masks, filters and legacy `clip` are conservatively omitted. Pseudo-elements, SVG and shadow DOM
  are not independently supported. The maximum clip depth is 16 including the element and viewport.
  Overflow clip-margin expansion is not reproduced; clipping remains conservative.
- Opacity follows the scalar product, not full CSS group compositing with foreground content.
  Group filters, blend modes, paint containment and complex occlusion are not a general CSS renderer.
  Use simple background panels rather than arbitrary decorated content.
- CSS-only selection needs `CSS.registerProperty` and readable stylesheet rules in WebView2.
  Explicit markers still work without property registration. Direct JavaScript-only CSSOM edits
  such as `insertRule` without DOM/theme changes require reloading the theme. Use regular Seelen
  theme reloads; those refresh the controller automatically.
- Frontend-to-native geometry synchronization is asynchronous, so moving CSS and Composition
  layers can differ briefly during fast animation. It is suitable for background panels, not a
  frame-perfect animation primitive. GPU/runtime differences and Windows display settings require
  testing. No fallback to full-window Acrylic is applied.
- Per-element blur amount is rebuilt only when the amount changes. Continuously animating that
  number is more expensive than moving or resizing an existing visual.

## Performance

For measured before/after results, reproducible benchmarks, lifecycle findings and
the limits of the GPU/WebView2 evidence, see [the performance report](native-blur-performance.md).

Static regions are not resent. Ordinary changes are coalesced to at most 30 geometry batches per second,
with one IPC request in flight and only the newest pending snapshot retained. Animation polling
stops when relevant animations stop. Unused themes allocate no Composition host and run no timer
loop. The mutation observer still watches for later opt-in changes.
Animation start/end/cancel boundaries request an immediate animation-frame read rather than
waiting for the ordinary geometry throttle.

The MVP permits at most 32 visible regions, 16 clips per region, `64px` blur, and 64 million
backing pixels of total region area per Widget. Prefer one background panel over many small or
overlapping regions. Test 100%/150%/200% display scaling, multiple monitors, autohide and popup
animations before enabling always-visible surfaces. There is no claim of zero GPU cost.

## Manual integration acceptance

1. Rebuild the core package and UI as well as the Rust debug binary. Older frontend bundles cannot
   start the new controller. Restart the standard community-nightly debug binary.
2. Apply the example CSS to one transparent Widget panel through a temporary test theme. Confirm
   `data-slu-native-blur-state="ready"` and the runtime log entry `Native blur attached below WebView2`.
3. Place a high-contrast window behind the panel. Check background blur, sharp foreground text,
   independent corner radii and rounded overflow clipping. Confirm the corners stay transparent.
4. Click another app, drag and resize, change display scaling, trigger autohide/popup close, remove
   the opt-in rule, reload the theme, and restart the Widget. Check that there are no residual visuals
   or new input-blocking windows. Loss of focus must not change the blur.
5. Keep the feature experimental until this actual WebView2 layering test passes. The standalone
   panel test alone is not sufficient to claim support in all Widgets.

## Popup opacity animation synchronization

The controller bridges simple two-keyframe CSS `opacity` transitions/animations on
the selected element and its ancestors to a Composition scalar animation. Themes
keep their existing CSS; no Aurora-specific styles or API calls are required.
Supported timing is one normal iteration, positive playback rate, `replace`
composition, and linear/standard/cubic-bezier easing, up to 2 seconds. Unsupported
timing stays on geometry/opacity snapshot synchronization.

The bridge sends a bounded opacity curve once per animation generation. Rust skips
time already elapsed in IPC, and does not restart the curve when geometry snapshots
arrive. A reversal/replacement cancels the previous native animation. Browser and
Composition clocks are separate; this is phase correction, not frame-atomic
composition. Position, scale, and clipping still use the existing 30 Hz snapshots.

Widget hide arms an independent native visibility deadline before waiting for newly
triggered close animations (the existing 200 ms cap is retained). It never awaits
blur cleanup before hiding the HWND. Geometry and visibility have separate ordering:
a visibility epoch rejects old frames, old close requests, and expired cleanup tasks
after a new show. A native root-opacity gate cuts off the layer at the deadline;
the native cleanup task then releases its resources. This does not add another fade
or change blur quality. Initial delivery still depends on IPC and the native UI
thread; this is not frame-atomic synchronization or a guarantee against GPU stalls.
See [close lifecycle and regression evidence](native-blur-close-lifecycle.md).

Manual checks: fade in/out, reverse a transition, reopen during hide, switch popup,
lose focus, change theme, and verify that blur leaves no visible residue. Also test
unsupported animations (steps, infinite, complex keyframes) for snapshot fallback.

