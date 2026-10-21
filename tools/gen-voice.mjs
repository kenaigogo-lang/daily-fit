// 用 Azure 語音服務把 data.js 裡所有要講的句子做成 mp3，放在 audio/。
// 已經存在的檔案不會重做；不再用到的舊檔會刪掉。由 GitHub Actions「產生語音」執行。
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data.js', 'utf8') + '\n;this.out={lines:allVoiceLines(),file:voiceFile,VOICE};', ctx);
const { lines, file, VOICE } = ctx.out;

const key = process.env.AZURE_SPEECH_KEY, region = process.env.AZURE_SPEECH_REGION;
if (!key || !region) {
  console.error('缺少 AZURE_SPEECH_KEY 或 AZURE_SPEECH_REGION：請到 repo 的 Settings › Secrets and variables › Actions 設定');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

fs.mkdirSync('audio', { recursive: true });
const wanted = new Set(lines.map(file));
let made = 0;
for (const text of lines) {
  const f = file(text);
  if (fs.existsSync(f)) continue;
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${VOICE.name}"><prosody rate="${VOICE.rate}">${esc(text)}</prosody></voice></speak>`;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'daily-fit'
      },
      body: ssml
    });
    if (r.ok) { fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); made++; console.log('✓', f, text.slice(0, 30)); break; }
    if (r.status === 429 && attempt < 6) { await sleep(5000 * attempt); continue; }
    throw new Error(`Azure 回應 ${r.status}：${await r.text()}（句子：${text}）`);
  }
  await sleep(3200); // 免費方案每分鐘最多 20 次
}

for (const f of fs.readdirSync('audio')) {
  const p = 'audio/' + f;
  if (f.endsWith('.mp3') && !wanted.has(p)) { fs.unlinkSync(p); console.log('刪除舊檔', p); }
}
fs.writeFileSync('audio/manifest.json', JSON.stringify([...wanted].sort()));
console.log(`完成：新產生 ${made} 個，共 ${wanted.size} 個語音檔`);
