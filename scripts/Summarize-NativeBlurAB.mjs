// Summarize real process counters, not GPU frame times. No user paths/logs in public output.
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/Summarize-NativeBlurAB.mjs input.json output.json');
const raw = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
const stats = (values) => {
  const list = values.filter(Number.isFinite).sort((a,b) => a-b);
  return list.length ? { n:list.length, mean:list.reduce((a,b)=>a+b,0)/list.length,
    median:list[Math.floor((list.length-1)*0.5)], p95:list[Math.ceil(list.length*0.95)-1],
    min:list[0], max:list.at(-1), first:values.find(Number.isFinite), last:values.findLast(Number.isFinite) } : null;
};
const trials = raw.Trials.map((trial) => {
  const groups = {};
  for (const group of ['Seelen-tree', 'DWM-shared-desktop']) {
    const cpu=[], memory=[], dedicated=[], shared=[], engines = new Map();
    for (const sample of trial.Samples) {
      const rows = sample.Processes.filter(row => row.Group === group);
      const cpuRows=rows.map(row=>row.CpuPercentNormalized).filter(Number.isFinite);
      cpu.push(cpuRows.length ? cpuRows.reduce((a,b)=>a+b,0) : null);
      memory.push(rows.reduce((sum,row)=>sum+row.PrivateBytes,0));
      const gpuMemory=rows.flatMap(row=>row.GpuMemory);
      dedicated.push(gpuMemory.reduce((sum,row)=>sum+row.DedicatedUsage,0));
      shared.push(gpuMemory.reduce((sum,row)=>sum+row.SharedUsage,0));
      const engineSample = new Map();
      for (const engine of rows.flatMap(row=>row.Engines)) {
        const key=engine.Name.replace(/^pid_\d+_/, '');
        engineSample.set(key,(engineSample.get(key)||0)+engine.UtilizationPercentage);
      }
      for (const key of new Set([...engines.keys(),...engineSample.keys()])) {
        if (!engines.has(key)) engines.set(key, Array(memory.length-1).fill(0));
        engines.get(key).push(engineSample.get(key)||0);
      }
    }
    groups[group]={cpuPercentNormalized:stats(cpu),privateMiB:stats(memory.map(v=>v/1048576)),
      attributedDedicatedMiB:stats(dedicated.map(v=>v/1048576)),attributedSharedMiB:stats(shared.map(v=>v/1048576)),
      gpuEngines:Object.fromEntries([...engines].map(([key,values])=>[key,stats(values)]))};
  }
  return {pair:trial.Pair,mode:trial.Mode,rounds:trial.Samples.length,seconds:trial.ActualSeconds,
    gpuTraceCaptured:typeof trial.Trace==='string' && /saved|儲存|存到|已將/i.test(trial.Trace),groups};
});
const differences=[];
for (const pair of [...new Set(trials.map(t=>t.pair))]) {
  const on=trials.find(t=>t.pair===pair&&t.mode==='on');
  const off=trials.find(t=>t.pair===pair&&t.mode==='off');
  if (!on||!off) continue;
  const groups={};
  for (const group of Object.keys(on.groups)) {
    const a=on.groups[group], b=off.groups[group];
    const gpu={};
    for (const key of new Set([...Object.keys(a.gpuEngines),...Object.keys(b.gpuEngines)])) {
      const av=a.gpuEngines[key]?.mean||0,bv=b.gpuEngines[key]?.mean||0;
      if (av||bv) gpu[key]={off:bv,on:av,deltaPercentagePoints:av-bv};
    }
    groups[group]={cpuDeltaPercentagePoints:a.cpuPercentNormalized.mean-b.cpuPercentNormalized.mean,
      privateMiBDelta:a.privateMiB.mean-b.privateMiB.mean,
      attributedDedicatedMiBDelta:a.attributedDedicatedMiB.mean-b.attributedDedicatedMiB.mean,gpu};
  }
  differences.push({pair,groups});
}
const summary={timestamp:raw.StartedUtc,restored:raw.Restored,executableSha256:raw.ExecutableSha256,
  commit:raw.Commit,windows:raw.Windows,gpus:raw.Gpus,cpu:raw.Cpu,scope:raw.Scope,
  hardwareAcceleration:raw.HardwareAcceleration,webviewGpuDisabledObserved:raw.WebviewGpuDisabledObserved,
  caveats:['Single physical machine, debug build, same live desktop; not all GPU vendors.',
    'WMI engine counters are integer percentage samples; low utilization has limited resolution.',
    'DWM is shared desktop activity. No engine percentages summed across different engines.',
    'Attributed GPU memory counters are not physical total VRAM; allocations can be shared.',
    'No pixel correctness, end-to-end latency, frame-time or long-term leak proof.'],trials,differences};
writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({restored:summary.restored,trials:trials.map(({pair,mode,rounds,seconds})=>({pair,mode,rounds,seconds})),differences},null,2));
