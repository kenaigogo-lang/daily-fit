// 用 Google Gemini TTS 把 data.js 裡所有要講的句子做成 mp3，放在 audio/。
// 已經存在的檔案不會重做；不再用到的舊檔會刪掉。由 GitHub Actions「產生語音」執行。
// 多句產生時會自動分批合併呼叫（節省免費方案每日請求額度，並讓短詞音色一致），
// 再交由 tools/split-batch.py 用 faster-whisper + 拼音序列對齊精準切分。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('data.js', 'utf8') + '\n;this.out={lines:allVoiceLines(),file:voiceFile,VOICE};', ctx);
const { lines, file, VOICE } = ctx.out;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('缺少 GEMINI_API_KEY：請到 repo 的 Settings › Secrets and variables › Actions 設定');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 將文字正規化為適合朗讀的形式（不影響 voiceFile 雜湊檔名）：
// 1. 數字範圍「8～10」轉為「8 到 10」
// 2. 括號補充說明改用逗號銜接，避免 TTS 把括號當成舞台指示略過
function toSpoken(text) {
  return text
    .replace(/(\d+)\s*[～~－-]\s*(\d+)/g, '$1 到 $2')
    .replace(/（([^）]+)）/g, '，$1，')
    .replace(/\(([^)]+)\)/g, '，$1，')
    .replace(/([，。！？；：])[，、]+/g, '$1')
    .replace(/[，、]+([，。！？；：])/g, '$1')
    .replace(/^，+|，+$/g, '')
    .trim();
}

const ensureEndPunct = s => (/[。！？]$/.test(s) ? s : s + '。');

// 平均分配切塊（例如 28 句上限 7 → 4 批各 7 句；52 句上限 13 → 4 批各 13 句）
function balancedChunks(arr, maxSize) {
  if (!arr.length) return [];
  const groups = Math.ceil(arr.length / maxSize);
  const size = Math.ceil(arr.length / groups);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function startSplitWorker() {
  const proc = spawn('python3', ['tools/split-batch.py', '--worker'], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const rl = readline.createInterface({ input: proc.stdout });
  const pending = [];
  rl.on('line', line => {
    const job = pending.shift();
    if (!job) return;
    try { job.resolve(JSON.parse(line)); }
    catch (e) { job.reject(new Error(`切分回傳格式錯誤：${line}`)); }
  });
  proc.on('exit', code => {
    while (pending.length) {
      pending.shift().reject(new Error(`split-batch.py 異常結束 (code=${code})`));
    }
  });
  return {
    split(wav, spec) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        proc.stdin.write(JSON.stringify({ wav, spec }) + '\n');
      });
    },
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

async function synthesizeWav(transcript, outWav) {
  for (let attempt = 1; ; attempt++) {
    if (lastCallStart > 0) {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastCallStart);
      if (wait > 0) await sleep(wait);
    }
    const model = models[modelIdx];
    lastCallStart = Date.now();

    const part = { text: transcript };
    if (VOICE.style) part.speechMetadata = { style: VOICE.style };

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
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: VOICE.name }
            }
          }
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
const wanted = new Set(lines.map(file));
let missing = lines.filter(t => !fs.existsSync(file(t)));
let made = 0;

if (missing.length > 0) {
  console.log(`準備產生 ${missing.length} 個語音檔（模型：${models[0]}，聲線：${VOICE.name}）`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-fit-tts-'));
  const worker = startSplitWorker();
  let batchSeq = 0;

  try {
    // 最多三輪：第 1 輪分批合併（約 8 次請求完成全部 80 句），若有個別句子切分未過則縮小批次補做
    const passes = missing.length <= 5
      ? [{ label: '單句產生', makeBatches: list => list.map(t => [t]) }]
      : [
          {
            label: '批次產生',
            makeBatches: list => {
              const shortLines = list.filter(t => !/[。；]/.test(t));
              const longLines = list.filter(t => /[。；]/.test(t));
              return [...balancedChunks(shortLines, 13), ...balancedChunks(longLines, 7)];
            }
          },
          { label: '小批補做', makeBatches: list => balancedChunks(list, 3) },
          { label: '單句補做', makeBatches: list => list.map(t => [t]) }
        ];

    for (const pass of passes) {
      missing = lines.filter(t => !fs.existsSync(file(t)));
      if (!missing.length) break;
      const batches = pass.makeBatches(missing);
      console.log(`▶ ${pass.label}：待做 ${missing.length} 句，共分 ${batches.length} 批`);

      for (const batch of batches) {
        const wavPath = path.join(tmpDir, `batch_${++batchSeq}.wav`);
        const spokenList = batch.map(toSpoken);
        const transcript = batch.length === 1
          ? spokenList[0]
          : spokenList.map(ensureEndPunct).join('\n\n<long pause>\n\n');

        const usedModel = await synthesizeWav(transcript, wavPath);
        const spec = batch.map((raw, idx) => ({
          index: idx,
          text: spokenList[idx],
          out: file(raw)
        }));
        const res = await worker.split(wavPath, spec);
        try { fs.unlinkSync(wavPath); } catch {}

        for (const idx of res.saved || []) {
          made++;
          console.log(`✓ [${usedModel}]`, file(batch[idx]), batch[idx].slice(0, 32));
        }
        if (res.failed?.length) {
          console.warn(`↻ 本批有 ${res.failed.length} 句將於下一輪補做：`, res.failed.map(i => batch[i].slice(0, 20)).join(' / '));
        }
      }
    }
  } finally {
    worker.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const stillMissing = lines.filter(t => !fs.existsSync(file(t)));
if (stillMissing.length > 0) {
  throw new Error(`仍有 ${stillMissing.length} 個語音檔未成功產生：${stillMissing.slice(0, 5).join('、')}`);
}

for (const f of fs.readdirSync('audio')) {
  const p = 'audio/' + f;
  if (f.endsWith('.mp3') && !wanted.has(p)) { fs.unlinkSync(p); console.log('刪除舊檔', p); }
}
const ready = [...wanted].filter(p => fs.existsSync(p)).sort();
fs.writeFileSync('audio/manifest.json', JSON.stringify(ready));
console.log(`完成：新產生 ${made} 個，共 ${ready.length} 個語音檔`);
