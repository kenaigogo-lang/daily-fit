// 檳城之旅：用訓練紀錄算步數 → 決定走到哪一站、解鎖哪些卡片。
// 所有進度都是從 S.logs 重算的（不另外存進度），S.trip 只存收藏與測驗答案。
// 依賴 index.html 的全域：S, save, dkey, addDays, $, toast

/* ===================== 步數與進度 ===================== */
const SLOT = 10; // 每段路上，每走 10 步解鎖一樣東西（第 1、2 次：線索＋小發現；第 3 次：小測驗＋小發現）
// 每天的步數：當天第一次完整課表 10 步（只做忙碌版 4 步），同一天每多練一次 +3 步（避免為了衝進度過度訓練）
function tripDays(){
  const by={};
  for(const l of S.logs){ if(l.date<TRIP.start) continue; (by[l.date]=by[l.date]||[]).push(l); }
  return Object.keys(by).sort().map(date=>{
    const ls=by[date], first=ls.some(l=>!l.quick)?10:4;
    return {date, steps:first+3*(ls.length-1)};
  });
}
const tripSteps=()=>tripDays().reduce((s,d)=>s+d.steps,0);
// 第 k 站（從 0 起算）需要的累積步數
const stopAt=k=>TRIP.firstSteps+TRIP.legSteps*k;
const PLAN_TOTAL=stopAt(TRIP.plannedStops-1);
function tripState(steps=tripSteps()){
  const n=TRIP.stops.length;
  let arrived=0; while(arrived<n && steps>=stopAt(arrived)) arrived++;
  const st={steps, arrived, done:arrived>=n};
  if(st.done){ st.cards=(n-1)*3; st.surplus=steps-stopAt(n-1); return st; }
  st.next=arrived;
  const from=arrived?stopAt(arrived-1):0, need=stopAt(arrived)-from;
  st.inLeg=steps-from; st.need=need;
  st.slots=arrived?Math.min(3,Math.floor(st.inLeg/SLOT)):0;   // 第一段（登岸）沒有線索
  st.cards=(arrived?(arrived-1)*3:0)+st.slots;
  return st;
}
// a → b 步之間新解鎖的東西（給練完畫面用）
function tripEvents(a,b){
  const ev=[];
  for(let k=0;k<TRIP.stops.length;k++){
    if(k>0) for(let j=1;j<=3;j++){
      const t=stopAt(k-1)+SLOT*j;
      if(a<t && t<=b){ ev.push({type:'card',card:TRIP.cards[(k-1)*3+j-1]}); ev.push(j<3?{type:'clue',stop:k,text:TRIP.stops[k].clues[j-1]}:{type:'quiz',stop:k}); }
    }
    if(a<stopAt(k) && stopAt(k)<=b) ev.push({type:'arrive',stop:k});
  }
  return ev;
}
// 每一站的抵達日期（重播每天的步數）
function tripArrivals(){
  const out={}; let sum=0, k=0;
  for(const d of tripDays()){
    sum+=d.steps;
    while(k<TRIP.stops.length && sum>=stopAt(k)){ out[TRIP.stops[k].id]=d.date; k++; }
  }
  return out;
}
const daysBetween=(a,b)=>Math.round((new Date(b+'T00:00')-new Date(a+'T00:00'))/864e5);
// 配速：用最近 14 天的平均步數，推算走完全程（升旗山）的日期
function tripPace(steps){
  const today=dkey(new Date()), left=daysBetween(today,TRIP.depart);
  const span=Math.min(14,daysBetween(TRIP.start,today)+1);
  const from=dkey(addDays(new Date(),-(span-1)));
  const recent=tripDays().filter(d=>d.date>=from).reduce((s,d)=>s+d.steps,0);
  const remain=Math.max(0,PLAN_TOTAL-steps);
  const p={left, remain};
  if(remain===0){ p.msg='🎉 全程走完了！'; return p; }
  if(span<4||recent===0){ p.msg=`全程約 ${PLAN_TOTAL} 步：平均每週練 5 天，就能在出發前登上升旗山。`; return p; }
  const rate=recent/span, eta=addDays(new Date(),Math.ceil(remain/rate)), etaKey=dkey(eta);
  const md=d=>`${+d.slice(5,7)}/${+d.slice(8,10)}`;
  if(etaKey<=TRIP.depart) p.msg=`✅ 照目前的速度，預計 ${md(etaKey)} 登上升旗山，比出發早 ${daysBetween(etaKey,TRIP.depart)} 天。`;
  else {
    const perWeek=Math.min(7,Math.ceil(remain/Math.max(1,left)*7/10));
    p.msg=`⏳ 照目前的速度會在 ${md(etaKey)} 走完。平均每週練 ${perWeek} 天就趕得上出發日。`;
  }
  return p;
}

/* ===================== 小工具 ===================== */
const tripFav=()=>(S.trip=S.trip||{fav:{},quiz:{}}).fav;
const tripQuiz=()=>(S.trip=S.trip||{fav:{},quiz:{}}).quiz;
function mapsUrl(q){ return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(q); }
const stopQuery=s=>s.maps||s.en+' George Town Penang';
const photoUrl=f=>'https://commons.wikimedia.org/wiki/Special:FilePath/'+encodeURIComponent(f)+'?width=800';
const chapterOf=n=>TRIP.chapters.find(c=>c.n===n);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function openSheet(html){
  const el=document.createElement('div'); el.className='sheet';
  el.innerHTML=`<div class="sheetbox tripsheet">${html}<button class="btn soft" style="margin-top:14px" onclick="this.closest('.sheet').remove()">關閉</button></div>`;
  el.onclick=e=>{ if(e.target===el) el.remove(); };
  document.body.appendChild(el); return el;
}
function favBtn(id){
  const on=!!tripFav()[id];
  return `<button class="favbtn ${on?'on':''}" onclick="toggleFav('${id}',this)">${on?'⭐ 已收藏':'☆ 收藏'}</button>`;
}
function toggleFav(id,btn){
  const f=tripFav(); if(f[id]) delete f[id]; else f[id]=1; save();
  if(btn){ const on=!!f[id]; btn.classList.toggle('on',on); btn.textContent=on?'⭐ 已收藏':'☆ 收藏'; }
  if($('tripov').classList.contains('show')) renderJournal();
}

/* ===================== 地圖 ===================== */
// 目前章節的簡易地圖：用經緯度投影，畫出路線、已抵達的站、目前位置 👣
function tripMap(st){
  const idx=st.done?TRIP.stops.length-1:st.next;
  const ch=TRIP.stops[idx].ch;
  const ks=TRIP.stops.map((s,k)=>k).filter(k=>TRIP.stops[k].ch===ch);
  if(ks[0]>0) ks.unshift(ks[0]-1); // 從上一章最後一站接過來
  const pts=ks.map(k=>TRIP.stops[k]);
  const W=320,H=190,P=30;
  const xs=pts.map(p=>p.lng), ys=pts.map(p=>p.lat);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  const sc=Math.min((W-2*P)/((x1-x0)||1e-4),(H-2*P)/((y1-y0)||1e-4));
  const ox=(W-(x1-x0)*sc)/2, oy=(H-(y1-y0)*sc)/2;
  const X=p=>ox+(p.lng-x0)*sc, Y=p=>oy+(y1-p.lat)*sc;
  const path=pts.map(p=>`${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
  // 走過的部分
  const walked=[]; let me=null;
  ks.forEach((k,i)=>{
    if(k<st.arrived) walked.push(`${X(pts[i]).toFixed(1)},${Y(pts[i]).toFixed(1)}`);
    if(!st.done && k===st.next && i>0){
      const a=pts[i-1], b=pts[i], f=Math.min(1,st.inLeg/st.need);
      me={x:X(a)+(X(b)-X(a))*f, y:Y(a)+(Y(b)-Y(a))*f};
      walked.push(`${me.x.toFixed(1)},${me.y.toFixed(1)}`);
    }
  });
  if(!me){ const k=st.done?ks[ks.length-1]:ks[0], p=TRIP.stops[k]; me={x:X(p),y:Y(p)}; }
  const placed=[];
  const dots=ks.map((k,i)=>{
    const p=pts[i], x=X(p), y=Y(p), got=k<st.arrived, nx=!st.done&&k===st.next;
    // 已抵達的站名寫在圓點下方（靠邊時往內對齊）；跟已經放好的站名太近就改放上方。還沒到的只顯示問號
    const anchor=x>W-60?'end':x<60?'start':'middle';
    let ly=y+21; if(placed.some(q=>Math.abs(q.x-x)<60&&Math.abs(q.y-ly)<14)) ly=y-13;
    if(got) placed.push({x,y:ly});
    const label=got?`<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" class="lb">${esc(p.name.replace(/（.*）/,''))}</text>`
      :`<text x="${x.toFixed(1)}" y="${(y+4).toFixed(1)}" text-anchor="middle" class="lb q">？</text>`;
    return `<g ${got?`class="mapstop" onclick="showStop('${p.id}')"`:''}>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${nx?9:8}" class="${got?'got':nx?'nx':'fut'}"/>
      ${got?`<text x="${x.toFixed(1)}" y="${(y+3.5).toFixed(1)}" text-anchor="middle" class="em">${p.emoji}</text>`:''}${label}</g>`;
  }).join('');
  return `<svg class="tripmap" viewBox="0 0 ${W} ${H}" role="img" aria-label="喬治市路線圖">
    <rect x="0" y="0" width="${W}" height="${H}" rx="12" class="bg"/>
    <text x="${W-12}" y="20" text-anchor="end" class="n">N↑</text>
    <polyline points="${path}" class="route"/>
    ${walked.length>1?`<polyline points="${walked.join(' ')}" class="walked"/>`:''}
    ${dots}
    <text x="${(me.x-12).toFixed(1)}" y="${(me.y-6).toFixed(1)}" text-anchor="end" class="me">👣</text>
  </svg>`;
}

/* ===================== 首頁卡片 ===================== */
function tripCard(){
  const st=tripState(), pace=tripPace(st.steps);
  const idx=st.done?TRIP.stops.length-1:st.next, ch=chapterOf(TRIP.stops[idx].ch);
  let status, clues='';
  if(st.done){
    const nextCh=chapterOf(TRIP.stops[TRIP.stops.length-1].ch+1);
    status=nextCh
      ?`🎉 第 ${TRIP.stops[idx].ch} 章走完了！第 ${nextCh.n} 章「${nextCh.title}」正在準備中，步數會先存著（已存 ${st.surplus} 步），開放後就能直接往前走。`
      :`🏔️ <b>恭喜登上升旗山，喬治市全程走完了！</b>24 站的故事都收進手帳了，3 月去的時候可以再打開重溫。之後多走的步數會先存著${st.surplus?`（已存 ${st.surplus} 步）`:''}，等番外篇開放。`;
  } else if(st.arrived===0){
    status='🚢 第一次練完，就會在瑞天咸碼頭登岸，正式踏上喬治市！';
  } else {
    const left=st.need-st.inLeg;
    status=`下一站：<b>❓ 第 ${st.next+1} 站</b>　還差 ${left} 步（大約再練 ${Math.ceil(left/10)} 次）`;
    const s=TRIP.stops[st.next], list=[];
    if(st.slots>=1) list.push(`<li>🔍 ${esc(s.clues[0])}</li>`);
    if(st.slots>=2) list.push(`<li>🔍 ${esc(s.clues[1])}</li>`);
    if(st.slots>=3) list.push(`<li>🧩 <a href="javascript:void 0" onclick="showQuiz(${st.next})">${tripQuiz()[s.id]!=null?'看小測驗答案':'回答小測驗'}</a></li>`);
    clues=list.length?`<ul class="clues">${list.join('')}</ul>`:`<p class="small muted" style="margin:6px 0 0">再練 1 次就會出現第一條線索。</p>`;
  }
  const favN=Object.keys(tripFav()).length;
  return `<div class="card trip">
    <div class="bhead"><h2 style="margin:0">🧳 檳城之旅</h2><span class="pill sky">✈️ 還有 ${Math.max(0,pace.left)} 天</span></div>
    <div class="small" style="margin:6px 0 0"><b>第 ${ch.n} 章「${ch.title}」</b><span class="muted">・${ch.sub}</span></div>
    <div class="small muted" style="margin:0 0 8px">已抵達 ${st.arrived} / ${TRIP.plannedStops} 站・共走了 ${st.steps} 步</div>
    ${tripMap(st)}
    <div class="tripstatus">${status}</div>
    ${clues}
    <p class="small muted" style="margin:8px 0 10px">${pace.msg}</p>
    <div class="row"><button class="btn soft" onclick="openJournal('stops')">📖 旅行手帳</button><button class="btn soft" onclick="openJournal('fav')">⭐ 清單${favN?`（${favN}）`:''}</button></div>
  </div>`;
}

/* ===================== 故事卡、小發現卡、測驗 ===================== */
function showStop(id){
  const s=TRIP.stops.find(x=>x.id===id), ch=chapterOf(s.ch), date=tripArrivals()[id];
  const paras=s.story.map(p=>p.startsWith('【傳說】')?`<p class="legend"><span class="ltag">傳說</span>${esc(p.slice(4))}</p>`:`<p>${esc(p)}</p>`).join('');
  const credit=`照片：<a href="https://commons.wikimedia.org/wiki/File:${encodeURIComponent(s.photo.file)}" target="_blank" rel="noopener">${esc(s.photo.by)}・${esc(s.photo.lic)}</a>（Wikimedia Commons）`;
  openSheet(`<img class="tripphoto" src="${photoUrl(s.photo.file)}" alt="${esc(s.name)}" onerror="this.remove()">
    <div class="credit">${credit}</div>
    <div class="small muted">第 ${ch.n} 章「${ch.title}」・第 ${TRIP.stops.indexOf(s)+1} 站${date?`・${date.replace(/-/g,'/')} 抵達`:''}</div>
    <h2>${s.emoji} ${esc(s.name)}</h2><div class="small muted">${esc(s.en)}</div>
    <div class="story">${paras}</div>
    ${s.facts.map(f=>`<div class="fact">💡 ${esc(f)}</div>`).join('')}
    <div class="fact tipbox">🧭 <b>實際去的時候</b>　${esc(s.tip)}</div>
    <div class="row" style="margin-top:12px">${favBtn(s.id)}<a class="btn soft mapbtn" href="${mapsUrl(stopQuery(s))}" target="_blank" rel="noopener">📍 Google 地圖</a></div>`);
}
function cardHtml(c,withFav=true){
  const cat=TRIP_CAT[c.cat];
  return `<div class="dcard"><div class="small muted">${cat.i} ${cat.n}</div><b>${esc(c.title)}</b><p>${esc(c.text)}</p>
    ${withFav?`<div class="row">${favBtn(c.id)}${c.maps?`<a class="btn soft mapbtn" href="${mapsUrl(c.maps)}" target="_blank" rel="noopener">📍 附近哪裡吃</a>`:''}</div>`:''}</div>`;
}
function showQuiz(k){
  const s=TRIP.stops[k], q=s.quiz, ans=tripQuiz()[s.id];
  const opts=q.o.map((o,i)=>{
    let cls='';
    if(ans!=null){ if(i===q.a) cls='right'; else if(i===ans) cls='wrong'; }
    return `<button class="qopt ${cls}" ${ans!=null?'disabled':''} onclick="answerQuiz(${k},${i})">${esc(o)}</button>`;
  }).join('');
  const res=ans==null?'':`<div class="fact">${ans===q.a?'🎉 答對了！':'差一點！'} ${esc(q.note)}</div>`;
  const el=openSheet(`<div class="big">🧩</div><h2>猜猜下一站</h2><p>${esc(q.q)}</p><div class="qopts">${opts}</div>${res}
    <p class="small muted">答對答錯都不影響進度，只是好玩。</p>`);
  el.dataset.quiz=k;
}
function answerQuiz(k,i){
  tripQuiz()[TRIP.stops[k].id]=i; save();
  document.querySelectorAll('.sheet').forEach(e=>{ if(e.dataset.quiz==String(k)) e.remove(); });
  showQuiz(k);
  if(!$('ov').classList.contains('show')) renderHome();
}

/* ===================== 練完畫面的區塊 ===================== */
function tripFinishBlock(before,after){
  const gained=after-before;
  const ev=tripEvents(before,after);
  const st=tripState(after);
  const parts=ev.map(e=>{
    if(e.type==='arrive'){ const s=TRIP.stops[e.stop], last=e.stop===TRIP.plannedStops-1;
      const newCh=e.stop>0&&TRIP.stops[e.stop-1].ch!==s.ch?chapterOf(s.ch):null;
      return `${newCh?`<div class="fact">📖 進入第 ${newCh.n} 章「${newCh.title}」：${newCh.sub}</div>`:''}
        <div class="arrive"><div class="stamp">${s.emoji}</div><div><div class="small muted">📍 抵達第 ${e.stop+1} 站${last?'・終點':''}</div><b>${esc(s.name)}</b></div>
        <button class="btn" style="width:auto;padding:10px 14px" onclick="showStop('${s.id}')">讀故事</button></div>
        ${last?'<div class="fact">🏔️ <b>全程完成！</b>你們從瑞天咸碼頭一路走上升旗山，24 站全部收集完成。3/16 見，旅途愉快！</div>':''}`; }
    if(e.type==='card') return `<div class="small muted" style="margin-top:10px">🃏 路上小發現</div>${cardHtml(e.card)}`;
    if(e.type==='clue') return `<div class="fact">🔍 <b>新線索</b>　${esc(e.text)}</div>`;
    if(e.type==='quiz') return `<div class="fact">🧩 <b>下一站的小測驗解鎖了！</b> <a href="javascript:void 0" onclick="showQuiz(${e.stop})">現在回答</a></div>`;
  }).join('');
  let foot='';
  if(!ev.length){
    if(st.done) foot=`<p class="small muted">${TRIP.stops.length>=TRIP.plannedStops?'喬治市全程已完成 🏔️':'下一章準備中'}，步數先存著（已存 ${st.surplus} 步）。</p>`;
    else { const toSlot=st.arrived?SLOT-(st.inLeg%SLOT):st.need-st.inLeg; foot=`<p class="small muted">再 ${toSlot} 步就有新發現。</p>`; }
  }
  return `<div class="card tripdone"><div class="bhead"><b>🧳 檳城之旅</b><span class="pill sky">🚶 +${gained} 步</span></div>${parts}${foot}</div>`;
}

/* ===================== 旅行手帳（全螢幕） ===================== */
let journalTab='stops';
function openJournal(tab){ journalTab=tab||'stops'; renderJournal(); $('tripov').classList.add('show'); document.body.style.overflow='hidden'; }
function closeJournal(){ $('tripov').classList.remove('show'); document.body.style.overflow=''; renderHome(); }
function renderJournal(){
  const st=tripState(), arr=tripArrivals(), fav=tripFav();
  const tabs=[['stops','📍 景點'],['cards','🃏 路上發現'],['fav','⭐ 清單']].map(([k,n])=>`<button class="chip ${journalTab===k?'on':''}" onclick="journalTab='${k}';renderJournal()">${n}</button>`).join('');
  let body='';
  if(journalTab==='stops'){
    body=TRIP.chapters.map(ch=>{
      const ss=TRIP.stops.map((s,k)=>({s,k})).filter(x=>x.s.ch===ch.n);
      if(!ss.length) return `<div class="bgh">第 ${ch.n} 章　${ch.title}</div><p class="small muted">內容準備中，走到這裡之前就會開放。</p>`;
      return `<div class="bgh">第 ${ch.n} 章　${ch.title}<span class="small muted">　${ch.sub}</span></div><div class="stamps">${ss.map(({s,k})=>k<st.arrived
        ?`<button class="stampcard got" onclick="showStop('${s.id}')"><span class="stamp">${s.emoji}</span><b>${esc(s.name)}</b><small>${arr[s.id]?arr[s.id].slice(5).replace('-','/')+' 抵達':''}${fav[s.id]?' ⭐':''}</small></button>`
        :`<div class="stampcard"><span class="stamp">？</span><b>第 ${k+1} 站</b><small>${!st.done&&k===st.next?'正在前往':'尚未抵達'}</small></div>`).join('')}</div>`;
    }).join('');
  } else if(journalTab==='cards'){
    const got=TRIP.cards.slice(0,st.cards);
    body=(got.length?got.slice().reverse().map(c=>cardHtml(c)).join(''):'<p class="muted">練完就會在路上發現新東西！</p>')
      +`<p class="small muted" style="text-align:center">已發現 ${got.length} 張・還有 ${TRIP.cards.length-got.length} 張等你們發現</p>`;
  } else {
    const fs=TRIP.stops.filter(s=>fav[s.id]), fc=TRIP.cards.filter(c=>fav[c.id]);
    body=(!fs.length&&!fc.length)?'<p class="muted">在故事卡或小發現卡上按「☆ 收藏」，想去的地方和想吃的東西就會集中在這裡，3 月到檳城時直接打開用。</p>':'';
    if(fs.length) body+=`<div class="bgh">📍 想去的景點（${fs.length}）</div>`+fs.map(s=>`<div class="favrow"><span>${s.emoji}</span><div><b>${esc(s.name)}</b><small>${esc(s.en)}</small></div><a class="btn soft mapbtn" href="${mapsUrl(stopQuery(s))}" target="_blank" rel="noopener">📍 地圖</a><button class="x" onclick="toggleFav('${s.id}')" aria-label="取消收藏">✕</button></div>`).join('');
    if(fc.length) body+=`<div class="bgh">🍜 想吃想試的（${fc.length}）</div>`+fc.map(c=>`<div class="favrow"><span>${TRIP_CAT[c.cat].i}</span><div><b>${esc(c.title)}</b><small>${esc(c.text.slice(0,28))}…</small></div>${c.maps?`<a class="btn soft mapbtn" href="${mapsUrl(c.maps)}" target="_blank" rel="noopener">📍 找店</a>`:''}<button class="x" onclick="toggleFav('${c.id}')" aria-label="取消收藏">✕</button></div>`).join('');
    body+=`<details class="howto"><summary>怎麼存到 Google 地圖？</summary>
      <p><b>方法 A（推薦）：</b>點景點旁的「📍 地圖」→ 在 Google 地圖按「儲存」→ 存進你們建立的清單（例如「檳城 2027」）。之後在 Google 地圖逛到喬治市，收藏的點就會顯示在地圖上；清單也能分享給另一半一起編輯。</p>
      <p><b>方法 B（點很多時）：</b>按下面的按鈕下載 CSV 檔 → 用電腦打開 Google「我的地圖」（mymaps.google.com）→ 建立地圖 → 匯入這個檔案，所有景點一次放上去。手機上從 Google 地圖的「已儲存 › 地圖」打開。（小吃沒有固定地點，不會匯出）</p>
      ${fs.length?`<button class="btn soft" onclick="exportFavCsv()">⬇️ 下載景點 CSV（${fs.length} 個）</button>`:''}
    </details>`;
  }
  $('tripov').innerHTML=`<div class="top"><button onclick="closeJournal()">✕ 關閉</button><b style="flex:1">📖 喬治市旅行手帳</b></div>
    <div class="journal"><div class="chips" style="margin-bottom:12px">${tabs}</div>${body}</div>`;
}
function exportFavCsv(){
  const fav=tripFav(), q=s=>'"'+String(s).replace(/"/g,'""')+'"';
  const rows=TRIP.stops.filter(s=>fav[s.id]).map(s=>[q(s.name+' '+s.en),q(s.story[0].slice(0,120)+'…'),s.lat,s.lng].join(','));
  const csv='﻿Name,Description,Latitude,Longitude\n'+rows.join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='檳城收藏景點.csv';
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000);
}
