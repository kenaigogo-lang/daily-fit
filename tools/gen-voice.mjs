// 用 Google Gemini 3.8 TTS（Voice Design 零氣音清亮可愛女聲）把 data.js 語音做成單一步驟完整 MP3。
// 做法：先用 8 批免費額度產生 80 個無損原子 WAV（每個動作講解用逗號順暢一口氣唸完），
// 再將每個步驟會連播的組合（例如「動作名＋左右＋次數＋完整講解」）無縫拼接成單一 MP3，
// 徹底避免手機瀏覽器分段切換卡頓、掉句或被下一步截斷。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync('data.js', 'utf8') +
    '\n;this.out={lines:allVoiceLines(),clips:allVoiceClips(),file:voiceFile,VOICE};',
  ctx
);
const { lines, clips, file, VOICE } = ctx.out;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('缺少 GEMINI_API_KEY：請到 repo 的 Settings › Secrets and variables › Actions 設定');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 畫面文字維持簡潔，轉成語音時換成自然可愛的好友陪伴口吻（不影響 voiceFile 雜湊檔名）
const SWEET_MAP = {
  '準備，第一個動作': '準備囉，第一個是',
  '休息，下一個': '休息一下，下一個是',
  '換邊，下一個': '換邊囉，接下來',
  '組間休息，下一個': '先喘口氣，等等再一組',
  '左邊': '左邊',
  '右邊': '右邊',
  '完成！太棒了': '耶，全部做完啦，辛苦囉！'
};

function toSpoken(text) {
  if (VOICE.sweetScript) {
    if (SWEET_MAP[text]) return SWEET_MAP[text];
    let m;
    if ((m = text.match(/^(\d+)\s*下$/))) return `${m[1]} 下喔`;
    if ((m = text.match(/^(\d+)\s*秒$/))) return `${m[1]} 秒喔`;
    if ((m = text.match(/^每下停\s*(\d+)\s*秒$/))) return `每下停 ${m[1]} 秒`;
  }
  let out = text;
  if (VOICE.sweetScript) {
    out = out.replace(/準備好就按開始。?$/, '準備好就按開始囉！');
  }
  out = out
    .replace(/(\d+)\s*[～~－-]\s*(\d+)/g, '$1 到 $2')
    .replace(/（([^）]+)）/g, '，$1，')
    .replace(/\(([^)]+)\)/g, '，$1，');

  // 動作講解長句：把句中多個「。」「；」「：」換成「，」，讓模型一口氣自然流暢唸完不硬斷句
  if (out.length > 25 && !out.startsWith('今天會用到彈力帶')) {
    out = out
      .replace(/。+$/, '')
      .replace(/[。；：]/g, '，') + '。';
  }

  return out
    .replace(/([，。！？；：])[，、]+/g, '$1')
    .replace(/[，、]+([，。！？；：])/g, '$1')
    .replace(/^，+|，+$/g, '')
    .trim();
}

const ensureEndPunct = s => (/[。！？]$/.test(s) ? s : s + '。');

function balancedChunks(arr, maxSize) {
  if (!arr.length) return [];
  const groups = Math.ceil(arr.length / maxSize);
  const size = Math.ceil(arr.length / groups);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function startAudioWorker() {
  const proc = spawn('python3', ['tools/split-batch.py', '--worker'], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = [];
  rl.on('line', line => {
    const job = pending.shift();
    if (!job) return;
    try { job.resolve(JSON.parse(line)); }
    catch (e) { job.reject(new Error(`音檔處理回傳格式錯誤：${line}`)); }
  });
  proc.on('exit', code => {
    while (pending.length) {
      pending.shift().reject(new Error(`split-batch.py 異常結束 (code=${code})`));
    }
  });
  const call = payload =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  return {
    split: (wav, spec) => call({ wav, spec }),
    stitch: (inputs, out) => call({ cmd: 'stitch', inputs, out }),
    close() {
      rl.close();
      proc.stdin.end();
    }
  };
}

const models = [VOICE.model || 'gemini-3.8-flash-tts', VOICE.fallbackModel || 'gemini-3.8-flash-lite-tts']
  .filter((m, i, a) => m && a.indexOf(m) === i);
let modelIdx = 0;
let lastCallStart = 0;
const MIN_INTERVAL_MS = 21_000; // 免費方案每分鐘 3 次（間隔 21 秒最穩）

async function resolveTargetVoice() {
  if (!VOICE.designName || !VOICE.designPrompt) {
    return VOICE.baseVoice
      ? { id: VOICE.baseVoice, isCustom: true }
      : { id: VOICE.name, isCustom: false };
  }
  try {
    const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/voices?type=prompted&page_size=50', {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const found = (listData.voices || []).find(v => (v.display_name || v.displayName) === VOICE.designName && v.id);
      if (found) {
        console.log(`🎤 重用專案已建立的專屬聲線：${found.id} (${VOICE.designName})`);
        return { id: found.id, isCustom: true };
      }
    }

    const modeLabel = VOICE.baseVoice ? `Voice Remix（基於 ${VOICE.baseVoice}）` : 'Voice Design';
    console.log(`🎨 正在用 Gemini ${modeLabel} 建立全新專屬聲線 (${VOICE.designName})...`);
    lastCallStart = Date.now();
    const prompted = { input: VOICE.designPrompt };
    if (VOICE.baseVoice) prompted.base_voice = VOICE.baseVoice;

    const createRes = await fetch('https://generativelanguage.googleapis.com/v1beta/voices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        store: true,
        voice: {
          type: 'prompted',
          display_name: VOICE.designName,
          model: models[0],
          gender: 'female',
          language_code: 'cmn-TW',
          region_code: 'TW',
          prompted
        }
      })
    });

    if (createRes.ok) {
      const created = await createRes.json();
      const newId = created?.id || created?.voice?.id;
      if (newId) {
        console.log(`✨ 成功建立全新專屬聲線：${newId}`);
        return { id: newId, isCustom: true };
      }
    } else {
      const errTxt = await createRes.text();
      console.warn(`ℹ️ ${modeLabel} 回應 ${createRes.status}，改用備援聲線（${errTxt.slice(0, 180)}）`);
    }
  } catch (e) {
    console.warn(`ℹ️ Voice Design 連線略過，改用備援聲線：${e.message}`);
  }
  if (VOICE.baseVoice) {
    console.log(`🎤 沿用既有專屬聲線：${VOICE.baseVoice}`);
    return { id: VOICE.baseVoice, isCustom: true };
  }
  return { id: VOICE.name, isCustom: false };
}

async function synthesizeWav(transcript, outWav, targetVoice) {
  for (let attempt = 1; ; attempt++) {
    if (lastCallStart > 0) {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastCallStart);
      if (wait > 0) await sleep(wait);
    }
    const model = models[modelIdx];
    lastCallStart = Date.now();

    const style = targetVoice.isCustom
      ? VOICE.style
      : `Natural Taiwanese Mandarin accent, ${VOICE.style || ''}`.trim();
    const part = { text: transcript };
    if (style) part.speechMetadata = { style };

    const voiceConfig = targetVoice.isCustom
      ? { voice: targetVoice.id }
      : { prebuiltVoiceConfig: { voiceName: targetVoice.id } };

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [part] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig }
        }
      })
    });

    if (r.ok) {
      const data = await r.json();
      const b64 = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)?.inlineData?.data;
      if (b64) {
        fs.writeFileSync(outWav, Buffer.from(b64, 'base64'));
        return model;
      }
      if (attempt < 4) {
        console.warn(`⚠️ Gemini 回傳無音訊內容（finishReason=${data?.candidates?.[0]?.finishReason}），重試第 ${attempt} 次...`);
        await sleep(4000 * attempt);
        continue;
      }
      throw new Error(`Gemini 未回傳音訊：${JSON.stringify(data).slice(0, 300)}`);
    }

    const errText = await r.text();
    if (r.status === 402) {
      console.error('❌ Google AI Studio 回傳 402（Prepay 預付額度為 $0）：請改用免費方案專案 Key 或於 AI Studio 儲值。');
      process.exit(1);
    }
    if (r.status === 429) {
      const isDaily = /PerDay|per day|RequestsPerDay|DayPerProject/i.test(errText);
      if (isDaily && modelIdx + 1 < models.length) {
        console.warn(`⚠️ ${model} 今日免費額度已滿，自動切換至備援模型 ${models[modelIdx + 1]}`);
        modelIdx++;
        lastCallStart = 0;
        attempt--;
        continue;
      }
      if (!isDaily && attempt < 7) {
        const m = errText.match(/retry in ([0-9.]+)s|"retryDelay":\s*"([0-9.]+)s"/i);
        const sec = m ? Math.ceil(parseFloat(m[1] || m[2])) + 3 : 22 * attempt;
        console.warn(`⏳ 觸發速率限制 (429)，等待 ${sec} 秒後重試...`);
        await sleep(sec * 1000);
        lastCallStart = 0;
        continue;
      }
    }

    if (r.status >= 500 && attempt < 5) {
      console.warn(`⏳ Gemini 伺服器暫時忙碌 (${r.status})，重試第 ${attempt} 次...`);
      await sleep(5000 * attempt);
      continue;
    }

    throw new Error(`Gemini (${model}) 回應 ${r.status}：${errText.slice(0, 500)}`);
  }
}

fs.mkdirSync('audio', { recursive: true });
const wanted = new Set(clips.map(file));
const missingClips = clips.filter(parts => !fs.existsSync(file(parts)));
let made = 0;

if (missingClips.length > 0) {
  // 找出缺少的完整音檔所需要的所有原子句子
  const neededAtoms = new Set();
  for (const parts of missingClips) for (const p of parts) neededAtoms.add(p);
  const atomList = lines.filter(t => neededAtoms.has(t));
  for (const p of neededAtoms) if (!atomList.includes(p)) atomList.push(p);

  const targetVoice = await resolveTargetVoice();
  console.log(`準備產生 ${atomList.length} 段基礎無損音訊，並合成 ${missingClips.length} 個完整單一 MP3（模型：${models[0]}，聲線：${targetVoice.id}）`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-fit-tts-'));
  const atomDir = path.join(tmpDir, 'atoms');
  fs.mkdirSync(atomDir, { recursive: true });
  const atomWav = text =>
    path.join(atomDir, crypto.createHash('md5').update(text).digest('hex').slice(0, 12) + '.wav');

  const worker = startAudioWorker();
  let batchSeq = 0;

  try {
    const passes = atomList.length <= 5
      ? [{ label: '單句產生', makeBatches: list => list.map(t => [t]) }]
      : [
          {
            label: '批次產生基礎音訊',
            makeBatches: list => {
              const shortLines = list.filter(t => toSpoken(t).length <= 25);
              const longLines = list.filter(t => toSpoken(t).length > 25);
              return [...balancedChunks(shortLines, 13), ...balancedChunks(longLines, 8)];
            }
          },
          { label: '小批補做', makeBatches: list => balancedChunks(list, 3) },
          { label: '單句補做', makeBatches: list => list.map(t => [t]) }
        ];

    for (const pass of passes) {
      const todo = atomList.filter(t => !fs.existsSync(atomWav(t)));
      if (!todo.length) break;
      const batches = pass.makeBatches(todo);
      console.log(`▶ ${pass.label}：待做 ${todo.length} 句，共分 ${batches.length} 批`);

      for (const batch of batches) {
        const wavPath = path.join(tmpDir, `batch_${++batchSeq}.wav`);
        const spokenList = batch.map(toSpoken);
        const transcript = batch.length === 1
          ? spokenList[0]
          : spokenList.map(ensureEndPunct).join('\n\n<long pause>\n\n');

        const usedModel = await synthesizeWav(transcript, wavPath, targetVoice);
        const spec = batch.map((raw, idx) => ({
          index: idx,
          text: spokenList[idx],
          out: atomWav(raw)
        }));
        const res = await worker.split(wavPath, spec);
        try { fs.unlinkSync(wavPath); } catch {}

        for (const idx of res.saved || []) {
          console.log(`✓ [${usedModel}]`, spokenList[idx].slice(0, 36));
        }
        if (res.failed?.length) {
          console.warn(`↻ 本批有 ${res.failed.length} 句將於下一輪補做：`, res.failed.map(i => batch[i].slice(0, 20)).join(' / '));
        }
      }
    }

    const stillMissingAtoms = atomList.filter(t => !fs.existsSync(atomWav(t)));
    if (stillMissingAtoms.length > 0) {
      throw new Error(`仍有 ${stillMissingAtoms.length} 段基礎音訊未成功產生：${stillMissingAtoms.slice(0, 5).join('、')}`);
    }

    // 無損拼接每個步驟的完整單一 MP3
    console.log(`🔗 正在無縫拼接 ${missingClips.length} 個單一步驟 MP3...`);
    for (const parts of missingClips) {
      const outPath = file(parts);
      const inputs = parts.map((p, idx) => {
        const nextP = parts[idx + 1] || '';
        // 短詞（動作名、左右、次數）之間給俐落 70ms 換氣；接長句動作講解前給 160ms 自然停頓
        const gap_after_ms = idx === parts.length - 1 ? 0 : (nextP.length > 20 ? 160 : 70);
        return { wav: atomWav(p), gap_after_ms };
      });
      const stRes = await worker.stitch(inputs, outPath);
      if (!stRes.ok) throw new Error(`拼接失敗：${outPath} (${stRes.reason})`);
      made++;
    }
  } finally {
    worker.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const stillMissing = clips.filter(parts => !fs.existsSync(file(parts)));
if (stillMissing.length > 0) {
  throw new Error(`仍有 ${stillMissing.length} 個完整音檔未成功產生`);
}

for (const f of fs.readdirSync('audio')) {
  const p = 'audio/' + f;
  if (f.endsWith('.mp3') && !wanted.has(p)) { fs.unlinkSync(p); console.log('刪除舊檔', p); }
}
const ready = [...wanted].filter(p => fs.existsSync(p)).sort();
fs.writeFileSync('audio/manifest.json', JSON.stringify(ready));
console.log(`完成：新產生 ${made} 個，共 ${ready.length} 個完整單一語音檔`);
