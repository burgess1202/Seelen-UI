// Regression/A-B harness: actual controller/Widget/browser; modeled native IPC/Host/Window. No GPU measurements.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const core=process.cwd();
const out=path.resolve(process.argv[2] || '.dev/blur-stability-trace');
fs.mkdirSync(out,{recursive:true});
const require=createRequire(path.join(core,'package.json'));
const {build}=require('esbuild');
const {chromium}=require('C:/Users/jacky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');
const bundled=await build({stdin:{contents:`export {Widget_4} from './libs/core/src/state/widget/abstractions/4_visibility.ts';export {startNativeBlurController} from './libs/core/src/state/theme/nativeBlur.ts';`,resolveDir:core,loader:'ts'},
  bundle:true,write:false,format:'iife',globalName:'Probe',platform:'browser',plugins:[{name:'platform-mocks',setup(b){
    b.onResolve({filter:/^\.\/3_autosize\.ts$/},()=>({path:'parent',namespace:'probe'}));
    b.onResolve({filter:/^@tauri-apps\/api\/(core|window)$/},args=>({path:args.path,namespace:'probe'}));
    b.onLoad({filter:/[\\/]4_visibility\.ts$/},args=>{
      let contents=fs.readFileSync(args.path,'utf8');
      contents=contents.replace('const close = beginNativeBlurClose(budget);',"globalThis.stamp?.('widget.close.begin',{budget,animationCount:animations.length}); const close = beginNativeBlurClose(budget);");
      contents=contents.replace('await waitHideAnimations(animations, budget);',"await waitHideAnimations(animations, budget); globalThis.stamp?.('animation.wait.done',{budget,opacity:getComputedStyle(document.querySelector('.panel')).opacity});");
      return {contents,loader:'ts'};
    });
    b.onLoad({filter:/[\\/]nativeBlur\.ts$/},args=>{
      let contents=fs.readFileSync(args.path,'utf8');
      const original='await invoke("set_native_blur_visibility", { session, epoch, visible, deadlineMs });';
      contents=contents.replace(original,"globalThis.stamp?.('visibility.send',{session,epoch,visible,deadlineMs}); "+original+" globalThis.stamp?.('visibility.ack',{session,epoch,visible});");
      return {contents,loader:'ts'};
    });
    b.onLoad({filter:/.*/,namespace:'probe'},args=>({loader:'js',contents:args.path==='parent'?'export class Widget_3 {window=globalThis.testWindow}':args.path.endsWith('/core')?'export const invoke=(...args)=>globalThis.nativeInvoke(...args)':'export const getCurrentWindow=()=>globalThis.testWindow'}));
  }}]});
const scenarios=[
  {name:'normal-early-exit'},
  {name:'normal-legacy-exit',earlyExit:false},
  {name:'rapid-reopen',rapid:true},
  {name:'rapid-30-cycles',rapid:true,burst:30},
  {name:'old-visibility-ack-never-returns',rapid:true,stallControl:true},
  {name:'visibility-rejection-during-close',rejectControl:true},
  {name:'renderer-stall-120',stall:120},
  {name:'renderer-stall-320',stall:320},
  {name:'native-dispatch-delay-250',dispatch:250},
  {name:'geometry-inflight-delay-250',geometry:250,rapid:true},
  {name:'geometry-ack-never-returns',stallGeometry:true,rapid:true},
  {name:'aurora-3d-reopen',flip:true},
  {name:'old-geometry-rejects-after-reopen',rejectGeometry:true,rapid:true},
  {name:'diagnostics-on',trace:true},
];
const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
for(const config of scenarios) {
  const events=[],base=performance.timeOrigin+performance.now();
  const record=(event,details={},timestamp=performance.timeOrigin+performance.now())=>events.push({tMs:+(timestamp-base).toFixed(3),utc:new Date(timestamp).toISOString(),event,...details});
  const state={session:0,nextSession:0,sequence:0,epoch:0,deadline:Infinity,host:false};
  const timers=new Set();let armed=false;
  const page=await browser.newPage();
  page.on('console',message=>{const text=message.text();if(text.startsWith('NATIVE_BLUR_TIMELINE ')){try{const event=JSON.parse(text.slice('NATIVE_BLUR_TIMELINE '.length));record('production.'+event.stage,event,event.wallMs);}catch{}}});
  await page.exposeFunction('trace',(event,details,timestamp)=>record(event,details,timestamp));
  await page.exposeFunction('nativeInvoke',async(command,payload)=>{
    record('ipc.receive',{command,...(payload?{session:payload.session,epoch:payload.epoch??payload.visibilityEpoch,sequence:payload.sequence,regions:payload.regions?.length}: {})});
    if(command==='begin_native_blur_session'){state.session=++state.nextSession;state.sequence=0;state.epoch=0;state.deadline=Infinity;state.host=false;return state.session;}
    if(armed&&command==='set_native_blur_visibility'&&!payload.visible&&!state.controlFaultStarted&&(config.stallControl||config.rejectControl)){state.controlFaultStarted=true;if(config.stallControl)return new Promise(()=>{});throw new Error('Injected close-control rejection');}
    if(armed&&config.rejectGeometry&&command==='sync_native_blur_regions'&&!state.rejectionStarted){state.rejectionStarted=true; await sleep(250); throw new Error('Injected obsolete geometry rejection');}
    if(armed&&config.stallGeometry&&command==='sync_native_blur_regions'&&!state.stallStarted){state.stallStarted=true;
      record('native.model.geometryAck.stalled');return new Promise(()=>{});
    }
    const dispatch=armed?(command==='sync_native_blur_regions'?(config.geometry||0):(config.dispatch||0)):0;
    if(dispatch)await sleep(dispatch);
    record('native.model.dispatch',{command,queueDelayMs:dispatch});
    if(payload.session!==state.session){record('native.model.reject.session');return;}
    if(command==='set_native_blur_visibility') {
      if(payload.epoch<state.epoch){record('native.model.reject.oldClose',{epoch:payload.epoch});return;}
      if(payload.visible) {
        if(payload.epoch===state.epoch&&state.deadline!==Infinity){record('native.model.reject.sameEpochOpen');return;}
        if(state.deadline!==Infinity)state.host=false;
        state.epoch=payload.epoch;state.deadline=Infinity;
        record('native.model.open',{epoch:state.epoch});return;
      }
      state.deadline=payload.epoch===state.epoch?Math.min(state.deadline,payload.deadlineMs):payload.deadlineMs;
      state.epoch=payload.epoch;
      if(config.early&&state.host){state.host=false;record('native.model.host.cleared.earlyCandidate');}
      const epoch=state.epoch;
      record('native.model.rootGate.armed',{epoch,remainingMs:Math.max(0,state.deadline-Date.now()),lateMs:Math.max(0,Date.now()-payload.deadlineMs)});
      const clear=()=>{
        if(epoch!==state.epoch||Date.now()<state.deadline){record('native.model.cleanup.stale',{epoch});return;}
        state.host=false;record('native.model.host.cleared',{epoch,modelRootOpacity:0});
      };
      if(Date.now()>=state.deadline)clear();
      else {const timer=setTimeout(()=>{timers.delete(timer);clear();},Math.max(0,state.deadline-Date.now()));timers.add(timer);}
    } else if(command==='sync_native_blur_regions') {
      if(payload.sequence<=state.sequence){record('native.model.reject.sequence');return;}
      state.sequence=payload.sequence;
      const epoch=payload.visibilityEpoch??0;
      if(epoch<state.epoch){record('native.model.reject.oldGeometry',{epoch});return;}
      if(epoch>state.epoch){if(state.deadline!==Infinity)state.host=false;state.epoch=epoch;state.deadline=Infinity;}
      if(Date.now()>=state.deadline){state.host=false;record('native.model.reject.expiredGeometry',{epoch});return;}
      if(!payload.regions.length){state.host=false;record('native.model.host.cleared.emptyGeometry',{epoch});return;}
      if(!state.host&&state.deadline!==Infinity){record('native.model.reject.newHostWhileClosing');return;}
      state.host=true;
      record('native.model.host.updated',{epoch,regions:payload.regions.length,modelSpriteOpacity:payload.regions[0].opacity,animation:payload.regions[0].opacityAnimation});
    }
  });
  try {
    await page.setContent(`<style>.panel {--slu-native-blur:1;--slu-native-blur-amount:18px;width:200px;height:100px;border-radius:18px;opacity:1;transition:opacity 85ms linear;}
      html[data-widget-hidden] .panel {opacity:0;}
      html.flip .panel {transform:none;transition:transform 220ms linear,opacity 115ms linear,--slu-native-blur-amount 115ms linear;}
      html.flip[data-widget-hidden] .panel {transform:perspective(480px) rotateX(-90deg);--slu-native-blur-amount:0px;transition:transform 180ms linear,opacity 85ms linear,--slu-native-blur-amount 85ms linear;}
      </style><div class=panel>isolated popup</div>`);
    await page.evaluate(()=>{
      const timestamp=()=>performance.timeOrigin+performance.now();
      const panel=document.querySelector('.panel');
      globalThis.stamp=(event,details={})=>{void trace(event,details,timestamp());};
      let visible=true;
      globalThis.testWindow={show:async()=>{stamp('window.model.show.call');visible=true;stamp('window.model.visible',{visible});},hide:async()=>{stamp('window.model.hide.call',{cssOpacity:getComputedStyle(panel).opacity});visible=false;stamp('window.model.visible',{visible});},isVisible:async()=>visible,close:async()=>{stamp('window.model.close');}};
      new MutationObserver(()=>stamp('css.hiddenAttribute',{hidden:document.documentElement.hasAttribute('data-widget-hidden'),opacity:getComputedStyle(panel).opacity})).observe(document.documentElement,{attributes:true,attributeFilter:['data-widget-hidden']});
      for(const event of ['transitionrun','transitionstart','transitionend','transitioncancel'])panel.addEventListener(event,e=>stamp('css.'+event,{property:e.propertyName,elapsedTime:e.elapsedTime}));
    });
    await page.addScriptTag({content:bundled.outputFiles[0].text});
    await page.evaluate(config=>{globalThis.__SLU_NATIVE_BLUR_EARLY_EXIT__=config.earlyExit!==false;globalThis.__SLU_NATIVE_BLUR_TRACE__=config.trace===true;globalThis.controller=Probe.startNativeBlurController();globalThis.widget=new Probe.Widget_4();},config);
    for(let i=0;i<100&&!state.host;i++)await sleep(20);
    if(!state.host)throw new Error('Initial native model never ready');
    if(config.flip){await page.evaluate(()=>document.documentElement.classList.add('flip'));await sleep(260);}
    if(config.geometry||config.stallGeometry||config.rejectGeometry) {
      armed=true;await page.evaluate(()=>document.querySelector('.panel').style.width='201px');await sleep(30);
    }
    armed=true;record('scenario.start',{config});
    await page.evaluate(async config=>{
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const panel=document.querySelector('.panel');
      getComputedStyle(panel).opacity;
      stamp('widget.hide.call');const first=widget.hide().then(()=>stamp('widget.hide.resolved'));
      if(config.rapid) {
        await wait(15);stamp('widget.show.call');await widget.show();stamp('widget.show.resolved');
        await first;
        for(let cycle=0;cycle<(config.burst||0);cycle++){const h=widget.hide();await wait(5);await widget.show();await h;await wait(5);}
        await wait(400);
      } else {
        if(config.stall)setTimeout(()=>{stamp('renderer.block.start');const until=performance.now()+config.stall;while(performance.now()<until){}stamp('renderer.block.end');},20);
        await first;await wait(300);
        stamp('widget.show.call');await widget.show();stamp('widget.show.resolved');await wait(420);
      }
    },config);
    await sleep(100);
    record('scenario.end',{modelHostActive:state.host});
    const traceEvents=events.filter(e=>e.event.startsWith('production.'));
    if(config.trace) {
      for(const name of ['widget.hide.call','widget.hide.api.ack','animation.close.requested','animation.wait.complete','geometry.send','geometry.ack','visibility.send','visibility.ack'])
        if(!traceEvents.some(e=>e.event==='production.'+name))throw new Error('Missing diagnostic event: '+name);
      if(!traceEvents.some(e=>e.requestId))throw new Error('No correlated request ID');
    } else if(traceEvents.length)throw new Error('Diagnostics emitted while disabled');
    if(state.host!==(config.expectHost??true))throw new Error('Final model host does not match expected observation');
    results.push({name:config.name,passed:true,reproducedMissingBlur:config.expectHost===false,finalModel:{...state},events:[...events]});
    console.log(config.name+' events='+events.length);
  }catch(error){record('diagnostic.error',{message:error.message});results.push({name:config.name,passed:false,events:[...events]});}
  finally{for(const timer of timers)clearTimeout(timer);await page.close();}
}
} finally {await browser.close();}
for(const result of results) {
  const e=result.events;
  const hide=e.find(x=>x.event==='widget.hide.call'),hwnd=e.find(x=>x.event==='window.model.hide.call');
  const show=e.find(x=>x.event==='widget.show.call');
  const model=e.find(x=>x.event==='native.model.host.updated'&&show&&x.tMs>=show.tMs);
  const clear=e.find(x=>x.event.startsWith('native.model.host.cleared')&&hide&&x.tMs>=hide.tMs);
  const attr=e.find(x=>x.event==='css.hiddenAttribute'&&x.hidden);
  result.summary={hideToModelWindowHideMs:hide&&hwnd?+(hwnd.tMs-hide.tMs).toFixed(3):null,hideToModelHostClearMs:hide&&clear?+(clear.tMs-hide.tMs).toFixed(3):null,
    showToFirstModelHostUpdateMs:show&&model?+(model.tMs-show.tMs).toFixed(3):null,oldRequestRejections:e.filter(x=>x.event==='native.model.reject.oldClose'||x.event==='native.model.reject.oldGeometry').length,
    animationBeganWithHiddenAttribute:!!attr};
  console.log(JSON.stringify({name:result.name,...result.summary}));
}
fs.writeFileSync(path.join(out,'stability-timeline.json'),JSON.stringify({generatedAt:new Date().toISOString(),note:'Actual Widget_4/controller/browser animation. IPC queue, HWND visibility, native opacity/resources are models on a separate Node event loop; NOT real HWND/GPU observations.',results},null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
