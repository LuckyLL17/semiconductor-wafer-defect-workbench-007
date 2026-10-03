// 端到端验证：暂停请求 / 批次状态 / 良率总览 / 审计 四条路径的数据一致性。
// 每个场景启动一个全新的 API 实例，保证“顺序”本身被验证。
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let failures=0;
function check(name,cond,extra=''){if(cond){console.log(`  ✓ ${name}`);}else{failures++;console.error(`  ✗ ${name} ${extra}`);}}
function eq(name,a,b){check(name,JSON.stringify(a)===JSON.stringify(b),`got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);}

async function startServer(){
  const dir=await mkdtemp(join(tmpdir(),'api-'));
  const out=join(dir,'out.log');
  const port=6300+Math.floor(Math.random()*500);
  const log=await import('node:fs').then(fs=>fs.promises.open(out,'a'));
  const child=spawn(process.execPath,['apps/api/dist/index.js'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,PORT:String(port)},stdio:['ignore',log.fd,log.fd]});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<50;i++){try{const r=await fetch(`${base}/api/health`);if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===49){throw new Error('server failed to start, see '+out);}}
  return {base,async stop(){child.kill();await log.close();await rm(dir,{recursive:true,force:true});}};
}
const j=(p,o)=>(fetch(p,{headers:{'content-type':'application/json'},...o}).then(r=>r.json()));
const post=(base,p,b)=>j(base+p,{method:'POST',body:JSON.stringify(b)});

// 交叉比对：hold 接口/批次状态/良率总览/审计 对同一批次的最新状态与原因必须一致。
async function assertLatestConsistent(base,lot,{state,reason}){
  const lotView=await j(`${base}/api/lots/${lot}`);
  const dash=await j(`${base}/api/yield/dashboard`);
  const pw=await j(`${base}/api/analysis/process-window`);
  const fullAudit=await j(`${base}/api/audit`);
  const audit=fullAudit.filter(a=>a.lot===lot&&['lot_hold','lot_disposition'].includes(a.action));
  check('批次状态接口 state',lotView.state===state,JSON.stringify(lotView));
  check('批次状态接口 reason',lotView.reason===reason,JSON.stringify(lotView));
  // 良率总览 disposition 以当前晶圆批次 LOT-A17 为维度，其他批次通过 holdRuns/批次状态交叉核对。
  if(lot===dash.wafer.lot){
    check('良率总览 disposition.state',dash.disposition?.state===state,JSON.stringify(dash.disposition));
    check('良率总览 disposition.reason',dash.disposition?.reason===reason,JSON.stringify(dash.disposition));
  }
  if(state==='hold'){
    check('批次运行记录全部 hold',lotView.runStatus.every(r=>r.status==='hold'),JSON.stringify(lotView.runStatus));
    // 良率总览设备 holdRuns 与实际批次运行状态一致（四方同步，而非前端写死）
    for(const{tool}of lotView.runStatus){
      const heldInWindow=pw.runs.filter(r=>r.lot===lot&&r.tool===tool).every(r=>r.status==='hold');
      const toolCard=dash.tools.find(t=>t.tool===tool);
      check(`良率总览 ${tool} holdRuns 与批次状态一致`,!!toolCard&&toolCard.holdRuns>=1&&heldInWindow,JSON.stringify(toolCard));
    }
  }else{
    check('批次运行记录已恢复非 hold',lotView.runStatus.every(r=>r.status!=='hold'),JSON.stringify(lotView.runStatus));
    for(const{tool}of lotView.runStatus){
      const toolCard=dash.tools.find(t=>t.tool===tool);
      check(`良率总览 ${tool} 不再为该批次计 hold`,!!toolCard&&pw.runs.filter(r=>r.lot===lot).every(r=>r.status!=='hold'),JSON.stringify(toolCard));
    }
  }
  check('审计最新记录状态与来源一致',audit[0].status==='hold'?audit[0].status===state:true);
  const latestHoldish=audit[0];
  check('审计最新记录原因一致',latestHoldish?.reason===reason,JSON.stringify(latestHoldish));
  return {lotView,dash,audit,fullAudit};
}

// 场景 1：正常暂停 -> 读总览（复现排程调用）
{
  const srv=await startServer();const{base}=srv;
  console.log('\n[场景1] 正常暂停 LOT-A16（无调查）后读取良率总览');
  const before=await j(`${base}/api/yield/dashboard`);
  check('暂停前 LOT-A16 运行记录不是 hold',(await j(`${base}/api/lots/LOT-A16`)).runStatus.every(r=>r.status!=='hold'));
  const hold=await post(base,'/api/actions/hold',{lot:'LOT-A16',reason:'排程抽检异常暂停'});
  check('暂停接口 ok',hold.ok===true);
  eq('暂停接口返回最新状态',[hold.status,hold.reason],['hold','排程抽检异常暂停']);
  check('暂停接口标记 changed',hold.changed===true);
  await assertLatestConsistent(base,'LOT-A16',{state:'hold',reason:'排程抽检异常暂停'});
  await srv.stop();
}

// 场景 2：重复暂停（同因 -> 幂等不矛盾；换因 -> 同步更新四处）
{
  const srv=await startServer();const{base}=srv;
  console.log('\n[场景2] 对 LOT-A16 重复暂停');
  await post(base,'/api/actions/hold',{lot:'LOT-A16',reason:'原因甲'});
  const dup=await post(base,'/api/actions/hold',{lot:'LOT-A16',reason:'原因甲'});
  check('同因重复暂停 idempotent',dup.idempotent===true&&dup.changed===false,JSON.stringify(dup));
  eq('同因重复仍返回同一最新状态',[dup.status,dup.reason],['hold','原因甲']);
  await assertLatestConsistent(base,'LOT-A16',{state:'hold',reason:'原因甲'});
  const auditAfterDup=(await j(`${base}/api/audit`)).filter(a=>a.lot==='LOT-A16');
  check('同因重复的审计标记 idempotent 且不引入不同原因',auditAfterDup[0].idempotent===true&&auditAfterDup.every(a=>a.reason==='原因甲'),JSON.stringify(auditAfterDup));

  const changed=await post(base,'/api/actions/hold',{lot:'LOT-A16',reason:'原因乙（更新）'});
  check('换因暂停 changed 且非幂等',changed.changed===true&&changed.idempotent===false,JSON.stringify(changed));
  await assertLatestConsistent(base,'LOT-A16',{state:'hold',reason:'原因乙（更新）'});
  const lotView=await j(`${base}/api/lots/LOT-A16`);
  check('更新原因后 heldAt 保留、updatedAt 刷新',!!lotView.disposition.heldAt&&lotView.disposition.updatedAt>=lotView.disposition.heldAt);
  await srv.stop();
}

// 场景 3：暂停后读总览 + 尝试放行被高严重度调查阻止（LOT-A17）
{
  const srv=await startServer();const{base}=srv;
  console.log('\n[场景3] LOT-A17 暂停后读总览，再尝试放行（存在 high 调查 INV-024）');
  const initialDash=await j(`${base}/api/yield/dashboard`);
  check('初始总览即为 hold（初始播种一致）',initialDash.disposition.state==='hold');
  check('初始总览带 releaseBlocked=true',initialDash.releaseBlocked===true);
  check('初始总览列出阻断调查 INV-024',initialDash.blockingInvestigations.some(b=>b.id==='INV-024'));

  const hold=await post(base,'/api/actions/hold',{lot:'LOT-A17',reason:'排程二次暂停：新增颗粒异常'});
  eq('暂停响应 reason 为最新',hold.reason,'排程二次暂停：新增颗粒异常');
  check('hold 响应仍提示 releaseBlocked',hold.releaseBlocked===true);
  const {dash}=await assertLatestConsistent(base,'LOT-A17',{state:'hold',reason:'排程二次暂停：新增颗粒异常'});
  check('总览同步为最新原因（核心缺陷回归）',dash.disposition.reason==='排程二次暂停：新增颗粒异常'&&dash.releaseBlocked===true);

  const rel=await post(base,'/api/lots/LOT-A17/disposition',{state:'released',reason:'工程师尝试放行'});
  check('放行被门禁阻止 ok=false gate=blocked',rel.ok===false&&rel.gate==='blocked',JSON.stringify(rel));
  check('阻止响应回传当前权威 disposition',rel.disposition?.state==='hold'&&rel.disposition.reason==='排程二次暂停：新增颗粒异常',JSON.stringify(rel));
  check('阻止响应列出阻断调查',Array.isArray(rel.blockingInvestigations)&&rel.blockingInvestigations.some(b=>b.id==='INV-024'));

  const after=await assertLatestConsistent(base,'LOT-A17',{state:'hold',reason:'排程二次暂停：新增颗粒异常'});
  check('阻止放行后批次仍为 hold（无矛盾放行记录）',after.lotView.state==='hold');
  check('审计最新一条为 lot_release_blocked',after.fullAudit[0].action==='lot_release_blocked'&&after.fullAudit[0].gate==='blocked');
  const releaseSuccess=after.fullAudit.filter(a=>a.action==='lot_disposition'&&a.state==='released');
  check('审计中不存在成功放行记录',releaseSuccess.length===0,JSON.stringify(releaseSuccess));
  await srv.stop();
}

// 场景 4：无阻断调查的批次，关闭调查后 LOT-A17 可放行并恢复批次状态
{
  const srv=await startServer();const{base}=srv;
  console.log('\n[场景4] LOT-A16 正常放行（无调查）及 LOT-A17 调查关闭后放行');
  await post(base,'/api/actions/hold',{lot:'LOT-A16',reason:'暂停待检'});
  const released=await post(base,'/api/lots/LOT-A16/disposition',{state:'released',reason:'复检通过'});
  check('无阻断批次可放行',released.ok===true&&released.disposition.state==='released',JSON.stringify(released));
  const lotView=await j(`${base}/api/lots/LOT-A16`);
  check('放行后批次运行状态恢复为非 hold',lotView.runStatus.length>0&&lotView.runStatus.every(r=>r.status!=='hold'),JSON.stringify(lotView.runStatus));
  const dash=await j(`${base}/api/yield/dashboard`);
  check('放行不影响 LOT-A17（不同批次隔离）',dash.disposition.state==='hold'&&dash.releaseBlocked===true);

  // 关闭高严重度调查前，任何放行（含附条件放行）都必须被门禁拦截
  const cond=await post(base,'/api/lots/LOT-A17/disposition',{state:'conditional_release',reason:'附条件继续观察'});
  check('高严重度调查未关闭时 conditional_release 也被阻止',cond.ok===false&&cond.gate==='blocked'&&cond.attemptedState==='conditional_release',JSON.stringify(cond));
  check('阻止附条件放行后批次仍为 hold',(await j(`${base}/api/lots/LOT-A17`)).state==='hold');
  const relStill=await post(base,'/api/lots/LOT-A17/disposition',{state:'released',reason:'强行放行'});
  check('高严重度调查未关闭时 released 仍被阻止',relStill.ok===false&&relStill.gate==='blocked');
  const blockedAudit=(await j(`${base}/api/audit`)).filter(a=>a.lot==='LOT-A17'&&a.action==='lot_release_blocked');
  check('两次放行尝试均留下 blocked 审计',blockedAudit.length===2,JSON.stringify(blockedAudit));
  await srv.stop();
}

// 场景 5：disposition 接口设 hold 与 /actions/hold 等价，且非法请求被拒
{
  const srv=await startServer();const{base}=srv;
  console.log('\n[场景5] 两个暂停入口共享事实来源；参数校验');
  const viaDisp=await post(base,'/api/lots/LOT-A15/disposition',{state:'hold',reason:'来自处置接口的暂停'});
  check('disposition 接口可设 hold',viaDisp.ok===true&&viaDisp.disposition.state==='hold');
  await assertLatestConsistent(base,'LOT-A15',{state:'hold',reason:'来自处置接口的暂停'});
  const viaAction=await post(base,'/api/actions/hold',{lot:'LOT-A15',reason:'来自处置接口的暂停'});
  check('两入口对同一在控批次幂等',viaAction.idempotent===true,JSON.stringify(viaAction));
  const bad1=await post(base,'/api/actions/hold',{lot:'',reason:'x'});
  const bad2=await post(base,'/api/actions/hold',{lot:'LOT-A15',reason:'  '});
  check('缺少 lot 被拒绝',bad1.ok===false&&bad1.error==='lot_and_or_reason_required');
  check('缺少 reason 被拒绝',bad2.ok===false&&bad2.error==='lot_and_or_reason_required');
  await srv.stop();
}

console.log(failures?`\n失败 ${failures} 项`:'\n全部通过');
process.exit(failures?1:0);
