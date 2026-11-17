// Actual Aurora CSS, controller and Widget lifecycle; platform IPC/window mocked.
// This checks geometry/timing logic, not live Windows/GPU presentation.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SLU_PLAYWRIGHT_PATH || 'playwright');
const output = '.dev/blur-flip-20261107';
fs.mkdirSync(output, { recursive: true });
const theme = fs.readFileSync('../aurora-glass-seelen-ui/shared/index.scss', 'utf8').replace(/^\s*\/\/.*$/gm, '');
const bundle = await build({ stdin: { contents: `export {Widget_4} from './libs/core/src/state/widget/abstractions/4_visibility.ts'; export {startNativeBlurController} from './libs/core/src/state/theme/nativeBlur.ts'; export {readNativeBlurGeometry} from './libs/core/src/state/theme/nativeBlurGeometry.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'Flip', plugins: [{ name: 'platform', setup(b) {
  b.onResolve({ filter: /^\.\/3_autosize\.ts$/ }, () => ({ path: 'parent', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/(window|core)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path === 'parent' ? 'export class Widget_3 {window=globalThis.testWindow}' : a.path.endsWith('/core') ? 'export const invoke=(...args)=>globalThis.testInvoke(...args)' : 'export const getCurrentWindow=()=>globalThis.testWindow' }));
} }] });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  const flipScenes = ['top', 'bottom', 'dpi-150', 'rapid-reopen', 'stalled-control', 'reduced-motion', 'opt-out', 'unsupported-ancestor'];
  for (const scene of process.env.SLU_BLUR_ISLAND_ONLY ? [] : flipScenes) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: scene === 'dpi-150' ? 1.5 : 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
      if (scene === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setContent(`<html data-widget-hidden style="--aurora-appearance-preset:Frost"><head><style>@layer aurora{${theme}}</style><style>
        body{margin:0;background:#061322;--aurora-appearance-preset:Frost}
        .wrapper{position:absolute;left:160px;top:80px}
        .slu-std-popover{--slu-native-blur:1;width:360px;height:340px;border-radius:24px;background:#427c94;box-sizing:border-box}
        </style></head><body><div class="wrapper"><div class="slu-std-popover network-popup">Flip fixture</div></div></body></html>`);
      await page.evaluate(scene => {
        const panel = document.querySelector('.slu-std-popover');
        if (scene === 'bottom') { panel.style.setProperty('--aurora-popup-flip-angle', '90deg'); panel.style.setProperty('--slu-widget-origin-y', '100%'); }
        if (scene === 'opt-out') { panel.style.setProperty('--slu-native-blur-projection', 'none'); panel.style.setProperty('--slu-native-blur-close', 'early'); }
        if (scene === 'unsupported-ancestor') document.querySelector('.wrapper').style.transform = 'perspective(700px) rotateY(12deg)';
        const mock = globalThis.mock = { frames: [], controls: [], hideCalls: 0, block: false, visible: false };
        globalThis.testWindow = { show: async () => { mock.visible = true; }, hide: async () => { mock.hideCalls++; mock.visible = false; }, close: async () => {}, isVisible: async () => mock.visible };
        globalThis.testInvoke = async (command, payload) => {
          if (command === 'begin_native_blur_session') return 1;
          if (command === 'sync_native_blur_regions') {
            mock.frames.push({ ...payload, at: performance.now(), transform: getComputedStyle(panel).transform, opacity: +getComputedStyle(panel).opacity });
          } else if (command === 'set_native_blur_visibility') {
            mock.controls.push({ ...payload, sentAt: Date.now() });
            if (mock.block) return new Promise(() => {});
          } else throw Error(command);
        };
      }, scene);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => { globalThis.controller = Flip.startNativeBlurController(); globalThis.widget = new Flip.Widget_4(); });
      await page.waitForTimeout(100);
      const enter = await page.evaluate(async () => {
        globalThis.showStarted = performance.now(); await widget.show();
        await new Promise(resolve => setTimeout(resolve, 300));
        const style = getComputedStyle(document.querySelector('.slu-std-popover'));
        return { frames: mock.frames.map(f => ({ polygons: f.regions.filter(r => r.clips[0].polygon).length, transform: f.transform, at: f.at - showStarted, opacity: f.opacity, scale: f.scale })), ready: document.documentElement.getAttribute('data-slu-native-blur-status'), diagnostic: { amount: style.getPropertyValue('--slu-native-blur-amount'), projection: style.getPropertyValue('--slu-native-blur-projection'), native: style.getPropertyValue('--slu-native-blur'), transform: style.transform } };
      });
      const polygons = enter.frames.filter(f => f.polygons);
      if (!polygons.length && scene === 'top') fs.writeFileSync(path.join(output, 'entry-debug.json'), JSON.stringify(enter, null, 2));
      if (['opt-out', 'reduced-motion', 'unsupported-ancestor'].includes(scene)) assert.equal(polygons.length, 0, scene);
      else assert.ok(polygons.some(f => f.at < 220 && f.opacity > 0), `${scene}: no native geometry during flip entry`);
      if (scene === 'unsupported-ancestor') assert.notEqual(enter.ready, 'ready');
      else assert.equal(enter.ready, 'ready', `${scene}: settled geometry not ready`);
      if (scene === 'dpi-150') assert.ok(enter.frames.some(f => f.scale === 1.5));
      const close = await page.evaluate(async scene => {
        const frameStart = mock.frames.length, controlStart = mock.controls.length;
        const start = performance.now();
        if (scene === 'stalled-control') mock.block = true;
        const hiding = widget.hide();
        if (scene === 'rapid-reopen') { await new Promise(r => setTimeout(r, 25)); await widget.show(); }
        await Promise.race([hiding, new Promise((_, reject) => setTimeout(() => reject(Error('hide waited for native ACK')), 650))]);
        await new Promise(r => setTimeout(r, 260));
        const exitFrames = mock.frames.slice(frameStart);
        const firstPlan = exitFrames[0]?.regions[0]?.opacityAnimation;
        return { elapsed: performance.now() - start, hideCalls: mock.hideCalls, controls: mock.controls.slice(controlStart), exitPolygons: exitFrames.filter(f => f.regions.some(r => r.clips[0].polygon)).length, firstFrameFades: firstPlan != null && firstPlan.values.at(-1) < firstPlan.values[0], hidden: document.documentElement.hasAttribute('data-widget-hidden'), lastCount: mock.frames.at(-1)?.regions.length };
      }, scene);
      if (scene === 'rapid-reopen') { assert.equal(close.hideCalls, 0); assert.equal(close.hidden, false); assert.ok(close.lastCount > 0); }
      else assert.equal(close.hideCalls, 1);
      const first = close.controls.find(c => !c.visible);
      if (scene !== 'unsupported-ancestor') {
        assert.ok(first, `${scene}: close was not sent`);
        if (scene === 'opt-out') assert.ok(first.deadlineMs - first.sentAt <= 5);
        else assert.ok(first.deadlineMs - first.sentAt > 120 && first.deadlineMs - first.sentAt <= 200);
      }
      if (['top', 'bottom', 'dpi-150', 'stalled-control'].includes(scene)) {
        assert.ok(close.firstFrameFades, `${scene}: first geometry missed the CSS exit fade`);
        assert.ok(close.exitPolygons > 0, `${scene}: no projected geometry during close`);
        const outlines = first.closeAnimation?.outlines;
        assert.ok(outlines?.length > 2, `${scene}: no batched close outlines`);
        assert.ok(outlines.every(points => points.length === outlines[0].length));
        assert.notDeepEqual(outlines[0], outlines.at(-1));
      }
      if (['reduced-motion', 'opt-out', 'unsupported-ancestor'].includes(scene)) {
        assert.equal(first?.closeAnimation, undefined, scene);
      }
      assert.deepEqual(errors, []);
      if (scene === 'top') {
        await page.evaluate(() => {
          document.documentElement.removeAttribute('data-widget-hidden');
          const panel = document.querySelector('.slu-std-popover');
          panel.style.setProperty('transition', 'none', 'important');
          panel.style.opacity = '1';
          panel.style.transform = 'perspective(480px) rotateX(-55deg)';
          const geometry = Flip.readNativeBlurGeometry(panel);
          if (!geometry?.clips[0].polygon) throw Error('Visual contour probe did not project');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('style', 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none');
          const outline = document.createElementNS(svg.namespaceURI, 'polygon');
          outline.setAttribute('points', geometry.clips[0].polygon.map(p => p.join(',')).join(' '));
          outline.setAttribute('fill', 'none'); outline.setAttribute('stroke', '#ffb55b'); outline.setAttribute('stroke-width', '1');
          svg.append(outline); document.body.append(svg);
        });
        await page.screenshot({ path: path.join(output, 'projected-contour.png') });
      }
      results.push({ scene, entryProjectedFrames: polygons.length, firstProjectedMs: polygons[0]?.at ?? null, exitProjectedFrames: close.exitPolygons, hideCalls: close.hideCalls, result: 'passed', platform: 'mock; no GPU measurement' });
    } finally { await page.close(); }
  }
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="proxy" data-native-blur style="position:absolute;left:100px;top:50px;width:360px;height:240px;transform-origin:0 0"></div>');
    await page.evaluate(() => {
      globalThis.frames = [];
      globalThis.testInvoke = async (command, payload) => {
        if (command === 'begin_native_blur_session') return 1;
        if (command === 'sync_native_blur_regions') {
          frames.push(payload);
          return !!payload.motion;
        }
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => Flip.startNativeBlurController());
    await page.waitForFunction(() => frames.some(frame => frame.regions.length));
    await page.evaluate(() => {
      const proxy = document.getElementById('proxy');
      const animation = proxy.animate([
        { transform: 'translate3d(0, 0, 0) scale(1, 1)', borderRadius: '18px', opacity: 1 },
        { transform: 'translate3d(130px, 0px, 0) scale(0.25, 0.1)', borderRadius: '80px', opacity: 0.92 },
      ], { duration: 240, easing: 'cubic-bezier(.4,0,.8,.2)', fill: 'forwards' });
      globalThis.islandAnimation = animation;
      proxy.setAttribute('data-slu-native-blur-motion', '');
      void animation.finished.then(() => { proxy.hidden = true; });
    });
    await page.waitForFunction(() => frames.some(frame => frame.motion));
    await page.waitForFunction(() => frames.at(-1)?.regions.length === 0);
    const captured = await page.evaluate(() => frames);
    const batched = captured.filter(frame => frame.motion);
    assert.equal(batched.length, 1, 'island motion keeps sending geometry after acknowledgment');
    const motion = batched[0].motion;
    assert.ok(motion.outlines.length >= 25 && motion.outlines.length <= 32);
    assert.ok(motion.outlines.every(outline => outline.length === 64));
    const width = points => Math.max(...points.map(point => point[0])) - Math.min(...points.map(point => point[0]));
    assert.ok(Math.abs(width(motion.outlines.at(-1)) - 90) < 0.1);
    assert.ok(width(motion.outlines[0]) > 300);
    assert.ok(Math.abs(motion.opacity.values.at(-1) - 0.92) < 0.00001);
    const maxOutlineError = await page.evaluate(plan => {
      const proxy = document.getElementById('proxy');
      const animation = globalThis.islandAnimation;
      const startTime = plan.opacity.startedAtMs - performance.timeOrigin - animation.startTime;
      proxy.hidden = false;
      proxy.removeAttribute('data-native-blur');
      animation.pause();
      let maxError = 0;
      for (let i = 0; i < plan.outlines.length - 1; i++) {
        animation.currentTime = startTime + (i + 0.5) * plan.opacity.durationMs / (plan.outlines.length - 1);
        const rect = proxy.getBoundingClientRect();
        const style = getComputedStyle(proxy);
        const matrix = new DOMMatrixReadOnly(style.transform);
        const radius = Math.min(Number.parseFloat(style.borderTopLeftRadius), 120, 180);
        const rx = radius * matrix.a, ry = radius * matrix.d;
        const centers = [[rect.left + rx, rect.top + ry], [rect.right - rx, rect.top + ry],
          [rect.right - rx, rect.bottom - ry], [rect.left + rx, rect.bottom - ry]];
        for (const [j, a] of plan.outlines[i].entries()) {
          const b = plan.outlines[i + 1][j];
          const corner = Math.floor(j / 16);
          const [cx, cy] = centers[corner];
          const angle = Math.PI * (1 + corner / 2 + (j % 16) / 30);
          maxError = Math.max(maxError, Math.hypot(
            (a[0] + b[0]) / 2 - (cx + rx * Math.cos(angle)),
            (a[1] + b[1]) / 2 - (cy + ry * Math.sin(angle)),
          ));
        }
      }
      return maxError;
    }, motion);
    assert.ok(maxOutlineError < 0.8, `island interpolated outline differs by ${maxOutlineError.toFixed(2)} CSS px`);
    results.push({ scene: 'activity-island-collapse', maxOutlineError, result: 'passed', platform: 'mock; no GPU measurement' });
  } finally { await page.close(); }
} finally { await browser.close(); }
fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
