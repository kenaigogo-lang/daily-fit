// 動作、課表資料：網頁（index.html）和語音產生程式（tools/gen-voice.mjs）共用
/* ===================== 動作庫 ===================== */
// kind: reps = 做完自己按下一個；time = 自動倒數。sided = 左右各做一次。hold = 每下停幾秒
const EX = {
  catcow:{name:'貓牛式',emoji:'🐈',kind:'time',cues:['四足跪姿：手在肩膀下、膝蓋在髖關節下','吸氣抬頭、腰往下沉；吐氣拱背、低頭','慢慢做，只在不痛的範圍內活動'],why:'喚醒脊椎，緩解久坐僵硬'},
  hipflexor:{name:'跪姿髖屈肌伸展',emoji:'🧎',kind:'time',sided:true,cues:['單膝跪地（膝下墊毛巾），另一腳在前','先夾緊屁股、骨盆微微往後捲，再把身體往前推','鼠蹊到大腿前側有拉感即可，腰不要拱'],why:'久坐會讓髖屈肌變緊，拉扯下背'},
  figure4:{name:'仰躺 4 字臀部伸展',emoji:'4️⃣',kind:'time',sided:true,cues:['仰躺，一腳腳踝放到另一腳膝蓋上','雙手抱住下方大腿，往胸口拉','屁股外側有拉感，放鬆呼吸'],why:'放鬆臀部外側、梨狀肌'},
  hamstring:{name:'彈力繩大腿後側伸展',emoji:'🦵',kind:'time',sided:true,gear:{type:'tube',m:'紅',f:'黃',how:'套在腳底（只是當拉帶用）'},cues:['仰躺，繩子套在腳底，膝蓋伸直往上拉','另一腳平放地面','大腿後側有拉感就好，不要硬拉'],why:'大腿後側太緊會牽動骨盆與下背'},
  doorway:{name:'門框胸肌伸展',emoji:'🚪',kind:'time',cues:['前臂貼門框，手肘和肩膀同高','身體往前跨一步，胸前有拉感','肩膀放鬆不要聳肩'],why:'打開久坐造成的圓肩'},
  curlup:{name:'McGill 捲腹',emoji:'🫁',kind:'reps',hold:8,cues:['仰躺，一腳彎曲一腳伸直，雙手墊在下背','頭和肩膀「微微」離地，停 8 秒','脖子不動，腰不要壓平也不要拱起'],why:'護腰版捲腹，不會反覆彎折腰椎'},
  sideplank:{name:'側棒式',emoji:'📐',kind:'time',sided:true,variants:['膝蓋著地版','直腿版','直腿版'],cues:['手肘在肩膀正下方','頭、身體到膝（或腳）成一直線','屁股不要往後坐，也不要往下垂'],why:'強化側腹與臀中肌，穩定骨盆'},
  birddog:{name:'鳥狗式',emoji:'🐕',kind:'reps',sided:true,hold:5,cues:['四足跪姿，背部保持平','同時伸出對側的手與腳，停 5 秒再收回','想像背上放一杯水不能灑出來'],why:'練背部與核心的穩定，閃腰族必備'},
  deadbug:{name:'死蟲式',emoji:'🪲',kind:'reps',cues:['仰躺，手朝天花板、膝蓋彎 90 度抬起','下背輕貼地面，慢慢伸出對側手腳','左右交替算一下；下背離地就縮小動作'],why:'練深層核心，同時保護下背'},
  plank:{name:'棒式',emoji:'🧱',kind:'time',cues:['手肘在肩膀下，身體成一直線','收小腹、夾屁股，不塌腰不翹臀','正常呼吸，不要憋氣'],why:'前側核心耐力'},
  glutebridge:{name:'臀橋',emoji:'🌉',kind:'reps',cues:['仰躺屈膝，腳跟靠近屁股','用屁股把骨盆推起，頂端停 1 秒','是屁股出力，不是用腰拱起來'],why:'喚醒久坐「失憶」的臀大肌'},
  bandbridge:{name:'彈力圈臀橋外撐',emoji:'🌉',kind:'reps',gear:{type:'loop',m:['黃','紅','黑'],f:['藍','黃','紅'],how:'套膝蓋上方'},cues:['彈力圈套在膝蓋上方','膝蓋持續往外撐住圈，再推起屁股','頂端停 2 秒，感受屁股外側出力'],why:'同時練臀大肌＋臀中肌'},
  clamshell:{name:'彈力圈蚌殼式',emoji:'🐚',kind:'reps',sided:true,gear:{type:'loop',m:['藍','黃','紅'],f:['綠','藍','黃'],how:'套膝蓋上方'},cues:['側躺，髖與膝彎約 45 度，圈套膝上','腳跟貼在一起，上面的膝蓋往上打開','骨盆不要往後翻，慢慢放下'],why:'直接強化臀中肌——就是你屁股上緣外側痠的位置'},
  sidelegraise:{name:'側躺抬腿',emoji:'🦩',kind:'reps',sided:true,cues:['側躺，下面的腳彎曲，上面的腳伸直、略往後','腳尖朝前（不要朝天花板）','用屁股外側把腿抬到約 45 度，停 1 秒'],why:'臀中肌主力訓練'},
  monsterwalk:{name:'彈力圈側走',emoji:'🦀',kind:'time',gear:{type:'loop',m:['藍','黃','紅'],f:['綠','藍','黃'],how:'套膝蓋上方（想更難就套腳踝）'},cues:['微蹲、背打直','往側邊走 8～10 步，再走回來','膝蓋不要往內夾，步伐小而穩'],why:'臀中肌＋骨盆穩定'},
  squat:{name:'深蹲',emoji:'🏋️',kind:'reps',cues:['腳與肩同寬，腳尖微朝外','屁股往後坐，膝蓋和腳尖同方向','蹲到不痛的深度，站起時夾屁股'],why:'下肢基礎力量'},
  pushup:{name:'伏地挺身',emoji:'💪',kind:'reps',variants:['跪膝版或標準版皆可','標準版','標準版（可放慢下降 3 秒）'],cues:['手略寬於肩，身體成一直線','下降時手肘約 45 度，不要往外開','核心收緊，腰不要塌'],why:'上肢推力＋核心'},
  bandrow:{name:'彈力繩划船',emoji:'🚣',kind:'reps',gear:{type:'tube',m:'紅',f:'黃',how:'中段繞門把或踩在腳下；雙手握近一點會更重'},cues:['雙手各握一端，站穩','手肘往後拉，肩胛骨往中間夾','慢慢放回，不要聳肩'],why:'強化上背，對抗久坐駝背'},
  pallof:{name:'彈力繩抗旋轉推',emoji:'🛡️',kind:'reps',sided:true,gear:{type:'tube',m:'紅',f:'黃',how:'固定在胸口高度、身體側邊；站離固定點近一點會比較輕'},cues:['側對固定點站穩，雙手握繩在胸前','把手往前推直，停 2 秒再收回','身體不要被繩子拉轉——這就是核心在出力'],why:'抗旋轉核心，保護腰椎最實用的練法'},
  march:{name:'原地高抬腿踏步',emoji:'🚶',kind:'time',cues:['原地踏步，膝蓋抬到髖的高度','手臂一起擺動','想多流汗就加快速度'],why:'暖身＋提高心跳'},
  lowjack:{name:'無跳開合跳',emoji:'⭐',kind:'time',cues:['一腳往側邊踏出，雙手同時往上舉','左右交替，加快速度','不用跳，保護膝蓋與腰'],why:'低衝擊有氧'}
};

/* ===================== 課表 ===================== */
// blocks: 每個 block 可以設 rounds（循環幾輪）；item: reps/sec、sets
const ROUTINES = {
  A:{name:'核心穩定日',emoji:'🛡️',focus:['護腰','核心'],desc:'McGill 護腰三大動作：捲腹、側棒式、鳥狗式',blocks:[
    {items:[{ex:'catcow',sec:40}]},
    {items:[{ex:'curlup',reps:5,sets:2},{ex:'sideplank',sec:20,sets:2},{ex:'birddog',reps:5,sets:2},{ex:'deadbug',reps:10}]},
    {items:[{ex:'hipflexor',sec:30}]}
  ]},
  B:{name:'臀部強化日',emoji:'🍑',focus:['臀中肌','骨盆'],desc:'針對屁股上緣外側痠：把臀中肌練起來',blocks:[
    {items:[{ex:'catcow',sec:40}]},
    {items:[{ex:'clamshell',reps:15,sets:2},{ex:'bandbridge',reps:12,sets:2},{ex:'sidelegraise',reps:12},{ex:'monsterwalk',sec:40}]},
    {items:[{ex:'figure4',sec:30}]}
  ]},
  C:{name:'全身肌力日',emoji:'💪',focus:['全身','姿勢'],desc:'你原本的深蹲＋伏地挺身＋棒式，再加上背部與抗旋轉',blocks:[
    {items:[{ex:'march',sec:45}]},
    {items:[{ex:'squat',reps:12,sets:2},{ex:'pushup',reps:10,sets:2},{ex:'bandrow',reps:15,sets:2},{ex:'pallof',reps:10},{ex:'plank',sec:30,sets:2}]},
    {items:[{ex:'doorway',sec:30}]}
  ]},
  D:{name:'輕有氧循環',emoji:'🔥',focus:['有氧','流汗'],desc:'低衝擊循環 2 輪，心跳拉起來但不傷腰',blocks:[
    {rounds:2,items:[{ex:'march',sec:40},{ex:'squat',reps:12},{ex:'lowjack',sec:40},{ex:'glutebridge',reps:12},{ex:'monsterwalk',sec:30},{ex:'plank',sec:20}]},
    {items:[{ex:'hipflexor',sec:30}]}
  ]},
  E:{name:'伸展恢復日',emoji:'🧘',focus:['伸展','放鬆'],desc:'輕鬆的活動度＋穩定練習，讓身體恢復',blocks:[
    {items:[{ex:'catcow',sec:40},{ex:'hipflexor',sec:30},{ex:'figure4',sec:30},{ex:'hamstring',sec:30},{ex:'birddog',reps:5},{ex:'deadbug',reps:10},{ex:'sideplank',sec:20},{ex:'doorway',sec:30}]}
  ]},
  Q:{name:'忙碌 3 分鐘版',emoji:'⚡',focus:['保持連續'],quick:true,desc:'真的沒時間也做一點，連續紀錄不中斷',blocks:[
    {items:[{ex:'catcow',sec:30},{ex:'glutebridge',reps:12},{ex:'sideplank',sec:15},{ex:'birddog',reps:5}]}
  ]}
};
const LEVELS = [{mult:1,name:'Lv1 入門'},{mult:1.3,name:'Lv2 進步'},{mult:1.6,name:'Lv3 強化'}];

function scaled(it,lv){
  const mult=LEVELS[lv].mult;
  if(it.reps) return {reps:Math.round(it.reps*mult)};
  return {sec:Math.max(10,Math.round(it.sec*mult/5)*5)};
}

/* ===================== 彈力帶 ===================== */
// gear.m / gear.f = 男生 / 女生用的顏色；陣列代表依難度 Lv1/Lv2/Lv3。
// 兩人同時練時，同一個動作男女顏色錯開，才不會搶同一條。
const BANDS = {
  loop:{name:'短彈力圈',full:'短彈力圈（FA020，套腿）',lb:{綠:'3–6 磅',藍:'10–12 磅',黃:'15–20 磅',紅:'25–30 磅',黑:'35–40 磅'}},
  tube:{name:'長彈力繩',full:'長彈力繩（FE002）',lb:{黃:'15 磅',紅:'35 磅',黑:'65 磅'}}
};
const BAND_HEX = {綠:'#22c55e',藍:'#3b82f6',黃:'#facc15',紅:'#ef4444',黑:'#1f2937'};
const gearColor = (g,who,lv) => Array.isArray(g[who]) ? g[who][lv] : g[who];
// 這個課表會用到的彈力帶：[{ex, g}]，依出現順序、不重複
function gearFor(rid){
  const seen=new Set(), out=[];
  for(const b of ROUTINES[rid].blocks) for(const it of b.items){
    const g=EX[it.ex].gear;
    if(g && !seen.has(it.ex)){ seen.add(it.ex); out.push({ex:it.ex,g}); }
  }
  return out;
}
// 開始前的語音提醒，例如：「今天會用到彈力帶。短彈力圈：男生藍色、黃色；女生綠色、藍色。…」
function gearLine(rid,lv){
  const list=gearFor(rid); if(!list.length) return null;
  const parts=['loop','tube'].map(type=>{
    const items=list.filter(x=>x.g.type===type); if(!items.length) return null;
    const cs=who=>[...new Set(items.map(x=>gearColor(x.g,who,lv)))].map(c=>c+'色').join('、');
    return `${BANDS[type].name}：男生${cs('m')}；女生${cs('f')}`;
  }).filter(Boolean);
  return `今天會用到彈力帶。${parts.join('。')}。準備好就按開始。`;
}

/* ===================== 語音（預先產生的音檔） ===================== */
// 改這裡的聲音或語速後，重新執行 GitHub Actions「產生語音」就會重做全部音檔
const VOICE = {name:'zh-TW-HsiaoChenNeural', rate:'+15%'};
const SIDES = ['左邊','右邊'];
const restLine = (label,first)=> first ? '準備，第一個動作' : `${label}，下一個`;
const amtLine = a => a.reps ? `${a.reps} 下` : `${a.sec} 秒`;
const holdLine = h => `每下停 ${h} 秒`;
const cueLine = ex => ex.cues.join('。')+'。';
const DONE_LINE = '完成！太棒了';
function allVoiceLines(){
  const set=new Set([DONE_LINE,...SIDES,restLine(null,true)]);
  ['休息','換邊','組間休息'].forEach(l=>set.add(restLine(l)));
  for(const ex of Object.values(EX)){ set.add(ex.name); set.add(cueLine(ex)); if(ex.hold) set.add(holdLine(ex.hold)); }
  for(const R of Object.values(ROUTINES)) for(const b of R.blocks) for(const it of b.items)
    LEVELS.forEach((_,lv)=>set.add(amtLine(scaled(it,lv))));
  for(const rid of Object.keys(ROUTINES)) LEVELS.forEach((_,lv)=>{ const g=gearLine(rid,lv); if(g) set.add(g); });
  return [...set];
}
// 檔名 = 聲音設定＋文字的雜湊：換聲音或改字就會產生新檔
function voiceFile(text){
  const s=VOICE.name+'|'+VOICE.rate+'|'+text; let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,0x01000193)>>>0; }
  return 'audio/'+h.toString(16).padStart(8,'0')+'.mp3';
}
