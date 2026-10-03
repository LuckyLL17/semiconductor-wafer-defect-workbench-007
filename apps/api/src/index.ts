import Fastify from 'fastify';
import cors from '@fastify/cors';

type Defect={id:string;x:number;y:number;size:number;kind:'particle'|'scratch'|'void'|'edge'|'cluster';severity:'low'|'medium'|'high';score:number;step:string;tool:string;lot:string;review:'unreviewed'|'confirmed'|'false_positive';note:string};
type ProcessRun={id:string;lot:string;recipe:string;tool:string;chamber:string;temperature:number;pressure:number;gasFlow:number;rfPower:number;yield:number;status:'normal'|'watch'|'hold';};
type DispositionState='released'|'hold'|'conditional_release';
type LotDisposition={state:DispositionState;reason:string;updatedAt:string;heldSince?:string};
const wafer={id:'WF-2026-09-30-A17',lot:'LOT-A17',diameter:300,product:'Logic-7nm',layer:'M2',recipe:'ETCH-M2-V4',timestamp:'2026-09-30T08:42:00Z'};
const defects:Defect[]=Array.from({length:48},(_,i)=>{const a=i*1.73;const r=35+(i%7)*12;const x=50+Math.cos(a)*r+(i%3)*3;const y=50+Math.sin(a)*r;const kind=i%11===0?'scratch':i%9===0?'edge':i%7===0?'void':i%5===0?'cluster':'particle';return{id:`D-${String(i+1).padStart(3,'0')}`,x:+x.toFixed(2),y:+y.toFixed(2),size:+(0.18+(i%6)*0.21).toFixed(2),kind,severity:i%13===0?'high':i%4===0?'medium':'low',score:+(0.61+(i%8)*.045).toFixed(2),step:i%3?'ETCH':'CLEAN',tool:i%2?'ETCH-04':'ETCH-03',lot:wafer.lot,review:i%10===0?'confirmed':'unreviewed',note:i%11===0?'连续线性缺陷，建议复核扫描':'自动检测候选缺陷'} });
const processRuns:ProcessRun[]=Array.from({length:12},(_,i)=>({id:`RUN-${i+1}`,lot:`LOT-A${String(17-i).padStart(2,'0')}`,recipe:i%2?'ETCH-M2-V4':'ETCH-M2-V3',tool:i%3?'ETCH-03':'ETCH-04',chamber:`CH-${(i%4)+1}`,temperature:+(42.2+(i%5)*.7).toFixed(1),pressure:+(18.4+(i%4)*.9).toFixed(2),gasFlow:+(126+(i%6)*2.2).toFixed(1),rfPower:+(780+(i%5)*11),yield:+(95.2-i*.34).toFixed(2),status:i<3?'watch':'normal'}));
const audits:Array<Record<string,unknown>>=[];
// 批次处置状态是 hold/disposition 的唯一事实来源（single source of truth），
// 暂停接口、批次 processRuns 状态、良率总览与审计都经由下面的辅助函数同步，
// 避免“接口与审计成功、总览仍是旧 disposition”的不一致。
const lotDispositions=new Map<string,LotDisposition>([[wafer.lot,{state:'hold',reason:'高风险线性缺陷待失效模式确认',updatedAt:'2026-09-30T09:10:00Z',heldSince:'2026-09-30T09:10:00Z'}]]);
// 记录批次被 hold 前各 process run 的原始状态，放行时恢复，避免放行后批次仍停在 hold。
const runStatusBackup=new Map<string,Array<{id:string;status:ProcessRun['status']}>>();
function releaseBlockers(lot:string){return investigations.filter(i=>i.lot===lot&&i.severity==='high'&&i.status!=='closed').map(i=>({investigationId:i.id,severity:i.severity,status:i.status,title:i.title}));}
function syncRunStatus(lot:string,held:boolean){
  if(held){
    if(!runStatusBackup.has(lot))runStatusBackup.set(lot,processRuns.filter(r=>r.lot===lot).map(r=>({id:r.id,status:r.status})));
    for(const r of processRuns)if(r.lot===lot)r.status='hold';
  }else{
    const backup=runStatusBackup.get(lot);
    if(backup){for(const r of processRuns){const b=backup.find(x=>x.id===r.id);if(b)r.status=b.status;}runStatusBackup.delete(lot);}
  }
}
// 统一的 hold 写入：幂等。同批次同原因重复暂停不产生新的矛盾审计记录；
// 原因变化时更新 disposition 并记一条带 supersede 信息的审计，保证“最新 hold 状态与原因”处处一致。
function applyHold(lot:string,reason:string,source:'schedule'|'api'){
  const at=new Date().toISOString();
  const existing=lotDispositions.get(lot);
  // hold 时始终把该批次的 process runs 同步为 hold（幂等）；种子即 hold、先放行再暂停等情况都能覆盖
  syncRunStatus(lot,true);
  if(existing&&existing.state==='hold'){
    if(existing.reason===reason)return {changed:false as const,duplicate:true as const,disposition:existing};
    const disposition={...existing,reason,updatedAt:at};
    lotDispositions.set(lot,disposition);
    audits.unshift({at,action:'lot_hold',lot,state:'hold',reason,previousReason:existing.reason,supersedesAt:existing.updatedAt,source});
    return {changed:true as const,duplicate:false as const,disposition};
  }
  const disposition:LotDisposition={state:'hold',reason,updatedAt:at,heldSince:existing?existing.heldSince??at:at};
  lotDispositions.set(lot,disposition);
  audits.unshift({at,action:'lot_hold',lot,state:'hold',reason,source});
  return {changed:true as const,duplicate:false as const,disposition};
}
function applyDisposition(lot:string,state:DispositionState,reason:string){
  const at=new Date().toISOString();
  const previous=lotDispositions.get(lot);
  const disposition:LotDisposition={state,reason,updatedAt:at,...(state==='hold'?{heldSince:previous?.heldSince??at}:{})};
  lotDispositions.set(lot,disposition);
  syncRunStatus(lot,state==='hold');
  audits.unshift({at,action:'lot_disposition',lot,state,reason,...(previous?{previousState:previous.state,previousReason:previous.reason}:{})});
  return disposition;
}
function spatial(){const cells=Array.from({length:25},()=>({count:0,high:0,score:0}));for(const d of defects){const ix=Math.max(0,Math.min(4,Math.floor(d.x/20)));const iy=Math.max(0,Math.min(4,Math.floor(d.y/20)));const c=cells[iy*5+ix];c.count++;c.high+=d.severity==='high'?1:0;c.score+=d.score}return cells.map((c,i)=>({cell:`${Math.floor(i/5)+1}-${i%5+1}`,count:c.count,high:c.high,density:+(c.count/((Math.PI*150**2)/25)).toFixed(4),meanScore:c.count?+(c.score/c.count).toFixed(2):0}));}
function clusters(){const groups=new Map<string,Defect[]>();for(const d of defects){const key=d.kind==='scratch'?`scratch-${Math.floor(d.y/15)}`:`grid-${Math.floor(d.x/20)}-${Math.floor(d.y/20)}`;groups.set(key,[...(groups.get(key)??[]),d])}return [...groups].map(([id,items])=>({id,count:items.length,kind:items[0].kind,centroid:{x:+(items.reduce((s,d)=>s+d.x,0)/items.length).toFixed(1),y:+(items.reduce((s,d)=>s+d.y,0)/items.length).toFixed(1)},maxSeverity:items.some(d=>d.severity==='high')?'high':items.some(d=>d.severity==='medium')?'medium':'low',tool:items[0].tool})).sort((a,b)=>b.count-a.count)}
function window(){const byTool=processRuns.reduce<Record<string,ProcessRun[]>>((m,r)=>(m[r.tool]=[...(m[r.tool]??[]),r],m),{});return Object.entries(byTool).map(([tool,rows])=>({tool,pointCount:rows.length,meanYield:+(rows.reduce((s,r)=>s+r.yield,0)/rows.length).toFixed(2),temperature:{min:Math.min(...rows.map(r=>r.temperature)),max:Math.max(...rows.map(r=>r.temperature))},pressure:{min:Math.min(...rows.map(r=>r.pressure)),max:Math.max(...rows.map(r=>r.pressure))},recommended:rows.filter(r=>r.yield>=94).map(r=>({recipe:r.recipe,chamber:r.chamber,temperature:r.temperature,pressure:r.pressure}))}));}
const app=Fastify({logger:false});await app.register(cors,{origin:true});
app.get('/api/health',async()=>({status:'ok',service:'wafer-defect-workbench'}));
app.get('/api/wafer/current',async()=>({wafer,summary:{defectCount:defects.length,highRisk:defects.filter(d=>d.severity==='high').length,confirmed:defects.filter(d=>d.review==='confirmed').length,clusterCount:clusters().length}}));
app.get('/api/defects',async(req)=>{const q=req.query as {kind?:string;severity?:string;review?:string};return defects.filter(d=>(!q.kind||d.kind===q.kind)&&(!q.severity||d.severity===q.severity)&&(!q.review||d.review===q.review));});
app.post('/api/defects/:id/review',async(req)=>{const id=(req.params as {id:string}).id;const body=req.body as {review:'confirmed'|'false_positive';note?:string};const d=defects.find(x=>x.id===id);if(!d)return {error:'defect_not_found'};d.review=body.review;if(body.note)d.note=body.note;audits.unshift({at:new Date().toISOString(),action:'defect_review',defectId:id,review:body.review});return d});
app.get('/api/analysis/spatial',async()=>({wafer,grid:spatial(),clusters:clusters(),hotspots:clusters().filter(c=>c.maxSeverity!=='low').slice(0,5)}));
app.get('/api/analysis/process-window',async()=>({runs:processRuns,window:window(),correlations:[{factor:'温度',metric:'缺陷密度',coefficient:-.62,interpretation:'高于 45°C 后颗粒缺陷密度上升'},{factor:'压力',metric:'划痕占比',coefficient:.48,interpretation:'压力波动与线性缺陷存在关联'},{factor:'RF功率',metric:'良率',coefficient:-.71,interpretation:'功率偏高时良率下降'}]}));
app.get('/api/analysis/compare',async()=>({current:{lot:wafer.lot,defects:defects.length,highRisk:defects.filter(d=>d.severity==='high').length,yield:93.7},baseline:{lot:'LOT-A16',defects:31,highRisk:2,yield:96.1},delta:{defects:17,highRisk:1,yield:-2.4}}));
app.post('/api/actions/hold',async(req,reply)=>{const body=(req.body??{}) as {lot?:string;reason?:string};const lot=typeof body.lot==='string'?body.lot.trim():'';const reason=typeof body.reason==='string'?body.reason.trim():'';if(!lot||!reason)return reply.code(400).send({ok:false,error:'lot_and_reason_required'});const result=applyHold(lot,reason,'schedule');const blockers=releaseBlockers(lot);return reply.send({ok:true,lot,status:result.disposition.state,...result.disposition,disposition:result.disposition,changed:result.changed,duplicate:result.duplicate,releaseBlocked:blockers.length>0,releaseBlockers:blockers});});
app.get('/api/audit',async()=>audits);

const investigations:Array<{id:string;lot:string;title:string;owner:string;status:'open'|'evidence'|'contained'|'closed';severity:string;hypotheses:Array<{id:string;cause:string;weight:number;state:'open'|'supported'|'rejected'}>;evidence:Array<{at:string;source:string;finding:string;weight:number}>}>=[{id:'INV-024',lot:wafer.lot,title:'M2 划痕簇异常调查',owner:'工艺整合工程师',status:'evidence',severity:'high',hypotheses:[{id:'H-1',cause:'ETCH-04 / CH-2 腔体颗粒脱落',weight:.68,state:'supported'},{id:'H-2',cause:'载具边缘接触磨损',weight:.42,state:'open'},{id:'H-3',cause:'AOI 分类模型漂移',weight:.16,state:'rejected'}],evidence:[{at:'2026-09-30T09:08:00Z',source:'空间聚类',finding:'线性簇与 CH-2 暴露批次重合',weight:.73},{at:'2026-09-30T09:20:00Z',source:'设备履历',finding:'上次湿法清洁后运行 186 小时',weight:.51}]}];
const experiments:Array<{id:string;name:string;lot:string;baseline:{temperature:number;pressure:number;rfPower:number};candidate:{temperature:number;pressure:number;rfPower:number};status:'draft'|'simulated'|'approved';result?:Record<string,number>}>=[];
function lotYieldDashboard(){const byTool=processRuns.reduce<Record<string,ProcessRun[]>>((out,row)=>(out[row.tool]=[...(out[row.tool]??[]),row],out),{});const disposition=lotDispositions.get(wafer.lot);const blockers=releaseBlockers(wafer.lot);const releaseBlocked=(disposition?.state==='hold')||blockers.length>0;return {wafer,defectDensity:+(defects.length/(Math.PI*150*150)*1_000_000).toFixed(2),dppm:Math.round(defects.length/Math.max(1,processRuns.length*25)*1_000_000),yieldLossEstimate:+(defects.filter(d=>d.severity==='high').length*.48+defects.filter(d=>d.severity==='medium').length*.11).toFixed(2),tools:Object.entries(byTool).map(([tool,rows])=>({tool,meanYield:+(rows.reduce((s,r)=>s+r.yield,0)/rows.length).toFixed(2),watchRuns:rows.filter(r=>r.status==='watch').length,holdRuns:rows.filter(r=>r.status==='hold').length,defectAssociation:+(defects.filter(d=>d.tool===tool).length/Math.max(1,defects.length)).toFixed(3)})),disposition,releaseEligibility:{releaseAllowed:!releaseBlocked,blockedByHold:disposition?.state==='hold',blockingInvestigations:blockers}};}
app.get('/api/yield/dashboard',async()=>lotYieldDashboard());
// 供排程/下游查询单一批次的最新状态与可放行结论，数据与总览同源
app.get('/api/lots/:lot/status',async(req,reply)=>{const lot=(req.params as {lot:string}).lot;const disposition=lotDispositions.get(lot);const runs=processRuns.filter(r=>r.lot===lot);const blockers=releaseBlockers(lot);if(!disposition&&runs.length===0&&blockers.length===0)return reply.code(404).send({error:'lot_not_found',lot});return reply.send({lot,disposition:disposition??null,runStates:runs.map(r=>({runId:r.id,status:r.status})),releaseEligibility:{releaseAllowed:disposition?.state!=='hold'&&blockers.length===0,blockedByHold:disposition?.state==='hold',blockingInvestigations:blockers}});});
app.get('/api/investigations',async()=>investigations);
app.post('/api/investigations',async(req)=>{const body=req.body as {lot?:string;title:string;owner?:string;severity?:string};const item={id:`INV-${String(investigations.length+25).padStart(3,'0')}`,lot:body.lot??wafer.lot,title:body.title,owner:body.owner??'未分配',status:'open' as const,severity:body.severity??'medium',hypotheses:[],evidence:[]};investigations.unshift(item);audits.unshift({at:new Date().toISOString(),action:'investigation_created',investigationId:item.id});return item});
app.post('/api/investigations/:id/evidence',async(req)=>{const item=investigations.find(x=>x.id===(req.params as {id:string}).id);if(!item)return {error:'investigation_not_found'};const body=req.body as {source:string;finding:string;hypothesisId?:string;weight?:number};item.evidence.unshift({at:new Date().toISOString(),source:body.source,finding:body.finding,weight:body.weight??.5});if(body.hypothesisId){const h=item.hypotheses.find(x=>x.id===body.hypothesisId);if(h){h.weight=Math.min(.99,+(h.weight+(body.weight??.08)).toFixed(2));h.state=h.weight>.6?'supported':h.state}}item.status='evidence';audits.unshift({at:new Date().toISOString(),action:'investigation_evidence_added',investigationId:item.id});return item});
app.post('/api/experiments',async(req)=>{const body=req.body as {name:string;candidate:{temperature:number;pressure:number;rfPower:number}};const item={id:`DOE-${experiments.length+1}`,name:body.name,lot:wafer.lot,baseline:{temperature:44.1,pressure:19.2,rfPower:813},candidate:body.candidate,status:'draft' as const};experiments.unshift(item);return item});
app.post('/api/experiments/:id/run',async(req)=>{const item=experiments.find(x=>x.id===(req.params as {id:string}).id);if(!item)return {error:'experiment_not_found'};const tempPenalty=Math.abs(item.candidate.temperature-43.6)*.18;const pressurePenalty=Math.abs(item.candidate.pressure-18.9)*.34;const rfPenalty=Math.abs(item.candidate.rfPower-792)*.012;const density=+(1.36+tempPenalty+pressurePenalty+rfPenalty).toFixed(3);item.result={predictedDefectDensity:density,predictedYield:+(96.4-density*.78).toFixed(2),scrapRisk:+Math.min(100,18+density*12).toFixed(1)};item.status='simulated';audits.unshift({at:new Date().toISOString(),action:'doe_simulated',experimentId:item.id});return item});
app.get('/api/traceability/:defectId',async(req)=>{const defect=defects.find(d=>d.id===(req.params as {defectId:string}).defectId);if(!defect)return {error:'defect_not_found'};return {defect,genealogy:[{stage:'来料批次',entity:'WAFER-SUB-A17',at:'2026-09-28T04:00:00Z'},{stage:'CLEAN',entity:'CLEAN-02 / CH-1',at:'2026-09-30T06:20:00Z'},{stage:'ETCH',entity:`${defect.tool} / CH-2`,at:'2026-09-30T07:18:00Z'},{stage:'AOI',entity:'AOI-M2-01',at:'2026-09-30T08:42:00Z'}],relatedLots:processRuns.filter(r=>r.tool===defect.tool).map(r=>({lot:r.lot,chamber:r.chamber,yield:r.yield,status:r.status}))}});
app.post('/api/lots/:lot/disposition',async(req,reply)=>{const lot=(req.params as {lot:string}).lot;const body=(req.body??{}) as {state?:DispositionState;reason?:string};const state=body.state;const reason=typeof body.reason==='string'?body.reason.trim():'';if(!state||!['released','hold','conditional_release'].includes(state))return reply.code(400).send({ok:false,error:'invalid_state'});if(!reason)return reply.code(400).send({ok:false,error:'reason_required'});
  // 暂停请求始终经由统一入口，保证与 /api/actions/hold 幂等行为一致
  if(state==='hold'){const result=applyHold(lot,reason,'api');const blockers=releaseBlockers(lot);return reply.send({ok:true,gate:'held',disposition:result.disposition,changed:result.changed,duplicate:result.duplicate,releaseEligibility:{releaseAllowed:blockers.length===0,blockedByHold:true,blockingInvestigations:blockers}});}
  // 只要存在未关闭的高严重度调查，无条件阻止放行，且不得改动现有 disposition
  const blockers=releaseBlockers(lot);
  if(state==='released'&&blockers.length>0){audits.unshift({at:new Date().toISOString(),action:'lot_release_blocked',lot,reason,blockingInvestigations:blockers});return reply.send({ok:false,gate:'blocked',reason:'存在未关闭的高严重度失效模式调查',blockingInvestigations:blockers,disposition:lotDispositions.get(lot)});}
  const disposition=applyDisposition(lot,state,reason);
  return reply.send({ok:true,gate:'passed',disposition,releaseEligibility:{releaseAllowed:true,blockedByHold:false,blockingInvestigations:[]}});});

await app.listen({host:'127.0.0.1',port:6201});
