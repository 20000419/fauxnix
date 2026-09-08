// Compare two independently built checkouts; do not synthesize the baseline
// by editing the optimized script. Timings exclude fixture setup and boot.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
if(!process.argv[2])throw Error('Usage: node scripts/benchmark-runtime-workloads.mjs BASELINE_CHECKOUT [CANDIDATE_CHECKOUT]');
const baselineRoot=resolve(process.argv[2]);
const candidateRoot=resolve(process.argv[3]||'.');
assert.notEqual(baselineRoot,candidateRoot,'use independently built baseline and candidate checkouts');
const revision=repo=>execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const root=mkdtempSync(join(tmpdir(),'fx-runtime-workloads-'));
const rounds=Number(process.env.FAUXNIX_BENCH_ROUNDS ?? 15);
const envCount=Number(process.env.FAUXNIX_BENCH_ENV_COUNT ?? 0);
assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 100);
assert.ok(Number.isInteger(envCount) && envCount >= 0 && envCount <= 1000);
const median=v=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)];
const environments={};
async function prepare(name,repo){
  const {FauxnixSession}=await import(pathToFileURL(join(repo,'dist/executor.js')));
  const {parseCommand}=await import(pathToFileURL(join(repo,'dist/parser.js')));
  const {translateCommandList}=await import(pathToFileURL(join(repo,'dist/translator.js')));
  await import(pathToFileURL(join(repo,'dist/commands/install-all.js')));
  const session=new FauxnixSession();
  const directory=join(root,name);mkdirSync(directory);mkdirSync(join(directory,'src','lib'),{recursive:true});mkdirSync(join(directory,'data'));
  for(let i=0;i<envCount;i++)session.env['FX_BENCH_'+i]='value-'+i;
  await session.prewarm();
  const compile=s=>translateCommandList(parseCommand(s));
  await session.run(compile(':'),{cwd:directory});
  environments[name]={session,directory,compile};
}
const workloads={
  read_report:Array.from({length:32},(_,i)=>`printf 'line${i}\\n'`).join('; '),
  state_updates:Array.from({length:16},(_,i)=>`FX_VAR=${i}; printf "$FX_VAR"`).join('; '),
  rename:"sed -i 's/oldName/newName/g' src/a.ts src/b.ts && printf 'src/a.ts\\nsrc/b.ts\\n' > result6.txt",
  table_pipeline:"tail -n +2 data/users.tsv | cut -f3 | sort | uniq -c | awk '{print $2, $1}' > result7.txt",
};
try{
  await prepare('baseline',baselineRoot);await prepare('candidate',candidateRoot);
  const reports=[];
  for(const [workload,command] of Object.entries(workloads)){
    const samples={baseline:[],candidate:[]};
    for(let r=-3;r<rounds;r++){
      const order=r%2?['candidate','baseline']:['baseline','candidate'];
      const answers={};
      for(const name of order){
        const {session,directory,compile}=environments[name];
        writeFileSync(join(directory,'src/a.ts'),'var oldName = 1;\nvar otherVar = 2;');
        writeFileSync(join(directory,'src/b.ts'),'console.log(oldName);\nvar newName = 3;');
        writeFileSync(join(directory,'src/lib/c.ts'),'export const oldName = "keep";');
        writeFileSync(join(directory,'data/users.tsv'),'name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA\nCarol\t35\tNYC\n');
        const plans=compile(command);
        const started=performance.now();
        const result=await session.run(plans,{cwd:directory});
        const elapsed=performance.now()-started;
        assert.equal(result.exitCode,0);
        answers[name]=result.stdout;
        if(workload==='rename'){
          assert.equal(readFileSync(join(directory,'src/a.ts'),'utf8'),'var newName = 1;\nvar otherVar = 2;\n');
          assert.equal(readFileSync(join(directory,'src/b.ts'),'utf8'),'console.log(newName);\nvar newName = 3;\n');
          assert.equal(readFileSync(join(directory,'src/lib/c.ts'),'utf8'),'export const oldName = "keep";');
          assert.equal(readFileSync(join(directory,'result6.txt'),'utf8'),'src/a.ts\nsrc/b.ts\n');
        }
        if(workload==='table_pipeline')assert.equal(readFileSync(join(directory,'result7.txt'),'utf8'),'LA 1\nNYC 2\n');
        if(r>=0)samples[name].push(elapsed);
      }
      assert.equal(answers.baseline,answers.candidate);
    }
    const baselineMs=median(samples.baseline),candidateMs=median(samples.candidate);
    const report={workload,rounds,extraEnvCount:envCount,baselineMs,candidateMs,speedup:baselineMs/candidateMs,samples};
    reports.push(report);console.log(JSON.stringify(report));
  }
  const report={node:process.version,ps:process.env.FAUXNIX_PS||'desktop',
    baselineRevision:revision(baselineRoot),candidateRevision:revision(candidateRoot),reports};
  if(process.env.FAUXNIX_BENCH_OUTPUT)writeFileSync(process.env.FAUXNIX_BENCH_OUTPUT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{
  for(const {session} of Object.values(environments))await session.dispose();
  rmSync(root,{recursive:true,force:true});
}
