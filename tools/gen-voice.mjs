// 用 Google Gemini 3.8 TTS（Voice Design 專屬台灣甜美女友聲線 + 微糖口語台詞）把 data.js 句子做成 mp3。
// 已經存在的檔案不會重做；不再用到的舊檔會刪掉。由 GitHub Actions「產生語音」執行。
// 多句產生時自動分批合併呼叫（節省免費方案每日請求額度，並讓短詞音色穩定一致），
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

// 畫面文字維持簡潔，轉成語音時自動替換成溫柔甜美女友陪伴口吻（不影響 voiceFile 雜湊檔名）
const SWEET_MAP = {
  '準備，第一個動作': '準備好囉，第一個是',
  '休息，下一個': '做得好棒，先休息一下喔，下一個是',
  '換邊，下一個': '換邊囉，接著做',
  '組間休息，下一個': '辛苦啦，喘口氣休息一下喔，等一下繼續做',
  '左邊': '左邊喔',
  '右邊': '右邊喔',
  '完成！太棒了': '<laugh> 耶，全部做完囉！你今天真的超棒的，辛苦你啦！'
};

function toSpoken(text) {
  if (VOICE.sweetScript) {
    if (SWEET_MAP[text]) return SWEET_MAP[text];
    let m;
    if ((m = text.match(/^(\d+)\s*下$/))) return `做 ${m[1]} 下喔`;
    if ((m = text.match(/^(\d+)\s*秒$/))) return `一起做 ${m[1]} 秒喔`;
    if ((m = text.match(/^每下停\s*(\d+)\s*秒$/))) return `每一下停 ${m[1]} 秒喔`;
  }
  let out = text;
  if (VOICE.sweetScript) {
    out = out.replace(/準備好就按開始。?$/, '準備好我們就按開始囉！');
  }
  return out
    .replace(/(\d+)\s*[～~－-]\s*(\d+)/g, '$1 到 $2')
    .replace(/（([^）]+)）/g, '，$1，')
    .replace(/\(([^)]+)\)/g, '，$1，')
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

// 取得或建立 Voice Design 專屬甜美女友聲線；若目前帳號不支援 Voice Design 則平滑退回內建高音柔聲 Achernar
async function resolveTargetVoice() {
  if (!VOICE.designName || !VOICE.designPrompt) {
    return { id: VOICE.name, isCustom: false };
  }
  try {
    const listRes = await fetch('https://generativelanguage.googleapis.com/v1beta/voices?type=prompted&page_size=50', {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const found = (listData.voices || []).find(v => (v.display_name || v.displayName) === VOICE.designName && v.id);
      if (found) {
        console.log(`🎤 重用專案已建立的專屬女友聲線：${found.id} (${VOICE.designName})`);
        return { id: found.id, isCustom: true };
      }
    }

    console.log(`🎨 正在用 Gemini Voice Design 捏製專屬聲線 (${VOICE.designName})...`);
    lastCallStart = Date.now();
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
          prompted: {
            input: VOICE.designPrompt
          }
        }
      })
    });

    if (createRes.ok) {
      const created = await createRes.json();
      const newId = created?.id || created?.voice?.id;
      if (newId) {
        console.log(`✨ 成功建立專屬台灣甜美女友聲線：${newId}`);
        return { id: newId, isCustom: true };
      }
    } else {
      const errTxt = await createRes.text();
      console.warn(`ℹ️ Voice Design 回應 ${createRes.status}，改用內建高音溫柔女聲 ${VOICE.name}（${errTxt.slice(0, 160)}）`);
    }
  } catch (e) {
    console.warn(`ℹ️ Voice Design 連線略過，改用內建高音溫柔女聲 ${VOICE.name}：${e.message}`);
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
      : `Natural Taiwanese Mandarin accent, sweet cute high-pitched girlfriend voice, ${VOICE.style || ''}`.trim();
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
      console.error(
        '❌ Google AI Studio 回傳 402（Prepay 預付額度為 $0）：\n' +
        '   這把 GEMINI_API_KEY 所屬的專案已綁定 Prepay 計費帳戶，但 AI Studio 預付餘額為 0（綁定計費後不會自動退回免費方案）。\n' +
        '   請改用未綁定計費（Free tier）專案的 API Key，或至 AI Studio Billing 頁面儲值。'
      );
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
const wanted = new Set(lines.map(file));
let missing = lines.filter(t => !fs.existsSync(file(t)));
let made = 0;

if (missing.length > 0) {
  const targetVoice = await resolveTargetVoice();
  console.log(`準備產生 ${missing.length} 個語音檔（模型：${models[0]}，聲線：${targetVoice.id}）`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-fit-tts-'));
  const worker = startSplitWorker();
  let batchSeq = 0;

  try {
    const passes = missing.length <= 5
      ? [{ label: '單句產生', makeBatches: list => list.map(t => [t]) }]
      : [
          {
            label: '批次產生',
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

        const usedModel = await synthesizeWav(transcript, wavPath, targetVoice);
        const spec = batch.map((raw, idx) => ({
          index: idx,
          text: spokenList[idx],
          out: file(raw)
        }));
        const res = await worker.split(wavPath, spec);
        try { fs.unlinkSync(wavPath); } catch {}

        for (const idx of res.saved || []) {
          made++;
          console.log(`✓ [${usedModel}]`, file(batch[idx]), '→', spokenList[idx].slice(0, 34));
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
