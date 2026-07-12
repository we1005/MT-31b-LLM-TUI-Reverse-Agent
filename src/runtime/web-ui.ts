/** rev-agent Web 前端:单页、自包含(内联 CSS+JS)、零外部资源。由 run-web-server 通过 Bun.serve 提供。 */
export const WEB_HTML = /* html */ `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rev-agent · web</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#7d8590;
    --user:#39c5cf; --assistant:#e6edf3; --reason:#8b949e; --tool:#d2a8ff; --toolres:#7d8590;
    --err:#ff7b72; --ok:#3fb950; --warn:#d29922; --accent:#58a6ff;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; display:flex; flex-direction:column; height:100vh; }
  header { padding:8px 14px; border-bottom:1px solid var(--border); background:var(--panel); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  header .title { font-weight:700; color:var(--accent); }
  header .meta { color:var(--dim); font-size:12px; }
  header .status { margin-left:auto; font-size:12px; }
  .status.idle { color:var(--ok); } .status.busy { color:var(--warn); }
  #budget { height:6px; background:var(--border); border-radius:3px; overflow:hidden; width:180px; }
  #budget > i { display:block; height:100%; background:var(--ok); width:0%; transition:width .3s; }
  .budget-wrap { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--dim); }
  #stream { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:8px; }
  .msg { white-space:pre-wrap; word-break:break-word; padding:6px 10px; border-radius:8px; max-width:100%; }
  .msg.user { color:var(--user); background:rgba(57,197,207,.08); border-left:3px solid var(--user); }
  .msg.assistant { color:var(--assistant); background:var(--panel); }
  .msg.tool-call { color:var(--tool); font-size:13px; }
  .msg.tool-result { color:var(--toolres); font-size:12px; padding-left:22px; }
  .msg.tool-denied { color:var(--err); font-size:13px; }
  .msg.error { color:var(--err); background:rgba(255,123,114,.08); border-left:3px solid var(--err); }
  .msg.warn { color:var(--warn); font-size:12px; }
  .reason { color:var(--reason); font-size:12.5px; background:rgba(139,148,158,.06); border-radius:8px; }
  .reason > summary { cursor:pointer; padding:6px 10px; user-select:none; }
  .reason > .body { padding:0 10px 8px 26px; white-space:pre-wrap; word-break:break-word; }
  .prefix { opacity:.75; margin-right:4px; }
  footer { border-top:1px solid var(--border); background:var(--panel); padding:10px 14px; display:flex; gap:8px; }
  #input { flex:1; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:8px; padding:9px 12px; font:inherit; }
  #input:focus { outline:none; border-color:var(--accent); }
  #send { background:var(--accent); color:#0d1117; border:none; border-radius:8px; padding:0 18px; font:inherit; font-weight:700; cursor:pointer; }
  #send:disabled { opacity:.4; cursor:not-allowed; }
  #approval { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; align-items:center; justify-content:center; }
  #approval.show { display:flex; }
  .card { background:var(--panel); border:1px solid var(--warn); border-radius:12px; padding:18px 20px; max-width:min(680px,92vw); }
  .card h3 { margin:0 0 8px; color:var(--warn); }
  .card pre { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; overflow:auto; max-height:40vh; margin:8px 0 14px; color:var(--fg); }
  .card .btns { display:flex; gap:10px; justify-content:flex-end; }
  .card button { border:none; border-radius:8px; padding:8px 18px; font:inherit; font-weight:700; cursor:pointer; }
  .approve { background:var(--ok); color:#0d1117; } .deny { background:var(--err); color:#0d1117; }
</style>
</head>
<body>
  <header>
    <span class="title">🔍 rev-agent</span>
    <span class="meta" id="meta">connecting…</span>
    <span class="budget-wrap">预算 <span id="budget"><i></i></span> <span id="budgetTxt">0/0</span></span>
    <span class="status idle" id="status">● idle</span>
  </header>
  <div id="stream"></div>
  <footer>
    <input id="input" placeholder="输入逆向任务后回车（Enter 发送）" autocomplete="off" />
    <button id="send">发送</button>
  </footer>
  <div id="approval"><div class="card">
    <h3>⚠ 工具审批</h3>
    <div id="apName"></div>
    <pre id="apArgs"></pre>
    <div class="btns"><button class="deny" id="deny">拒绝 (n)</button><button class="approve" id="approve">批准 (y)</button></div>
  </div></div>
<script>
(function(){
  const $ = (id)=>document.getElementById(id);
  const stream=$('stream'), input=$('input'), send=$('send'), status=$('status');
  const approval=$('approval'), apName=$('apName'), apArgs=$('apArgs');
  let curAsst=null, curReason=null, busy=false;
  const atBottom=()=> stream.scrollHeight-stream.scrollTop-stream.clientHeight < 40;
  const scroll=()=>{ stream.scrollTop=stream.scrollHeight; };
  function bubble(cls, text, prefix){
    const d=document.createElement('div'); d.className='msg '+cls;
    if(prefix){ const p=document.createElement('span'); p.className='prefix'; p.textContent=prefix; d.appendChild(p); }
    d.appendChild(document.createTextNode(text||'')); stream.appendChild(d); const b=atBottom(); if(b)scroll(); return d;
  }
  function setBusy(v){ busy=v; send.disabled=v; input.disabled=v;
    status.textContent=v?'● busy':'● idle'; status.className='status '+(v?'busy':'idle'); if(!v)input.focus(); }
  function ws(){
    const s=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
    s.onmessage=(e)=>{ const m=JSON.parse(e.data); handle(m,s); };
    s.onclose=()=>{ status.textContent='● 断开,重连中…'; status.className='status busy'; setTimeout(ws,1500); };
    window.__ws=s;
  }
  function handle(m,s){
    switch(m.type){
      case 'hello': $('meta').textContent='backend='+m.backend+' · '+m.cwd; setBusy(!!m.busy);
        if(m.budgetMax) budgetTxt(0,m.budgetMax); break;
      case 'userMsg': curAsst=null; curReason=null; bubble('user',m.text,'›'); break;
      case 'assistantDelta':
        if(!curAsst){ curAsst=bubble('assistant','',''); } curAsst.appendChild(document.createTextNode(m.text)); if(atBottom())scroll(); break;
      case 'assistantEnd': curAsst=null; break;
      case 'reasoningDelta':
        if(!curReason){ const d=document.createElement('details'); d.className='reason';
          const su=document.createElement('summary'); su.textContent='💭 思考中…（点击展开）'; d.appendChild(su);
          const b=document.createElement('div'); b.className='body'; d.appendChild(b); stream.appendChild(d); curReason=b; if(atBottom())scroll(); }
        curReason.appendChild(document.createTextNode(m.text)); break;
      case 'toolCall': curAsst=null; curReason=null; bubble('tool-call','['+m.name+'] '+fmt(m.args),'→'); break;
      case 'toolResult': bubble('tool-result','['+m.name+'] '+m.text,'←'); break;
      case 'toolDenied': bubble('tool-denied','['+m.name+'] '+m.reason,'✗'); break;
      case 'warn': bubble('warn',m.text,'⚠'); break;
      case 'error': bubble('error',m.text,'✗'); setBusy(false); break;
      case 'budget': budgetTxt(m.used,m.max,m.level); break;
      case 'busy': setBusy(m.v); break;
      case 'done': setBusy(false); if(m.used!=null)budgetTxt(m.used,m.max); curAsst=null; curReason=null; break;
      case 'approval': apName.textContent='工具：'+m.name; apArgs.textContent=fmt(m.args); approval.classList.add('show'); break;
    }
  }
  function fmt(a){ try{ return typeof a==='string'?a:JSON.stringify(a,null,2); }catch{ return String(a); } }
  function budgetTxt(used,max,level){ const pct=max?Math.min(100,Math.round(used/max*100)):0;
    const bar=$('budget').firstElementChild; bar.style.width=pct+'%';
    bar.style.background=level==='red'?'var(--err)':level==='yellow'?'var(--warn)':'var(--ok)';
    $('budgetTxt').textContent=(used/1000).toFixed(1)+'k/'+(max/1000).toFixed(0)+'k ('+pct+'%)'; }
  function submit(){ const t=input.value; if(!t.trim()||busy)return; window.__ws.send(JSON.stringify({type:'submit',text:t})); input.value=''; }
  function answer(ok){ approval.classList.remove('show'); window.__ws.send(JSON.stringify({type:'approvalResponse',ok})); }
  send.onclick=submit;
  input.addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); submit(); } });
  $('approve').onclick=()=>answer(true); $('deny').onclick=()=>answer(false);
  document.addEventListener('keydown',(e)=>{ if(!approval.classList.contains('show'))return;
    if(e.key==='y'||e.key==='Enter')answer(true); if(e.key==='n'||e.key==='Escape')answer(false); });
  ws(); input.focus();
})();
</script>
</body>
</html>`;
