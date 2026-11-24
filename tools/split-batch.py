#!/usr/bin/env python3
"""
將 Gemini TTS 產生的單段或多段合併 WAV 音檔，精準切分、去頭尾多餘空白並轉成 MP3。
若傳入多句（以 <long pause> 分隔），會用 faster-whisper 取得字詞時間軸 + pypinyin 拼音序列對齊，
再於兩句之間的最低能量靜音谷（Zero-Crossing）精準下刀，避免純靠靜音切分造成錯位。
"""
import io
import json
import math
import os
import re
import sys
import wave
import numpy as np

DIGITS = "零一二三四五六七八九"


def int_to_zh(n: int) -> str:
    if n < 0:
        return "負" + int_to_zh(-n)
    if n < 10:
        return DIGITS[n]
    if n < 20:
        return "十" + (DIGITS[n % 10] if n % 10 else "")
    if n < 100:
        return DIGITS[n // 10] + "十" + (DIGITS[n % 10] if n % 10 else "")
    if n < 1000:
        rem = n % 100
        if rem == 0:
            return DIGITS[n // 100] + "百"
        if rem < 10:
            return DIGITS[n // 100] + "百零" + DIGITS[rem]
        return DIGITS[n // 100] + "百" + int_to_zh(rem)
    return "".join(DIGITS[int(d)] for d in str(n))


def expand_numbers(text: str) -> str:
    return re.sub(r"\d+", lambda m: int_to_zh(int(m.group(0))), text)


def normalize_py(s: str) -> str:
    s = s.lower().strip()
    # 台灣常見前後鼻音、平翹舌近音正規化，用於容錯比對分數
    s = s.replace("zh", "z").replace("ch", "c").replace("sh", "s")
    s = s.replace("ing", "in").replace("eng", "en").replace("ang", "an")
    return s


def text_to_syllables(text: str):
    from pypinyin import Style, pinyin

    expanded = expand_numbers(text)
    chars = [ch for ch in expanded if re.match(r"[\u4e00-\u9fffA-Za-z]", ch)]
    if not chars:
        return []
    pys = pinyin("".join(chars), style=Style.NORMAL, errors="ignore")
    out = []
    for p in pys:
        if p and p[0]:
            out.append(p[0].lower())
    return out


def read_wav_pcm16(path: str):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:4] == b"RIFF":
        with wave.open(io.BytesIO(raw), "rb") as w:
            sr = w.getframerate()
            ch = w.getnchannels()
            sw = w.getsampwidth()
            frames = w.readframes(w.getnframes())
        if sw != 2:
            raise ValueError(f"Unsupported sample width: {sw}")
        pcm = np.frombuffer(frames, dtype=np.int16)
        if ch > 1:
            pcm = pcm.reshape(-1, ch)[:, 0]
        return pcm.copy(), sr
    # Raw 24kHz 16-bit mono PCM fallback
    if len(raw) % 2 == 1:
        raw = raw[:-1]
    return np.frombuffer(raw, dtype=np.int16).copy(), 24000


def trim_and_fade(pcm: np.ndarray, sr: int) -> np.ndarray:
    if len(pcm) == 0:
        return pcm
    win = max(1, int(sr * 0.015))  # 15ms frame
    hop = max(1, int(sr * 0.005))  # 5ms hop
    floats = pcm.astype(np.float32) / 32768.0
    if len(floats) < win:
        return pcm

    # Compute frame RMS
    sq = floats * floats
    csum = np.concatenate(([0.0], np.cumsum(sq)))
    starts = np.arange(0, len(floats) - win + 1, hop)
    rms = np.sqrt((csum[starts + win] - csum[starts]) / win)

    peak = float(np.max(rms)) if len(rms) else 0.0
    thresh = max(0.006, min(0.025, peak * 0.06))  # adaptive voice activity threshold
    voiced = np.where(rms >= thresh)[0]
    if len(voiced) == 0:
        return pcm

    lead_pad = int(sr * 0.055)   # 55ms lead-in
    tail_pad = int(sr * 0.110)   # 110ms natural tail
    s_idx = max(0, int(starts[voiced[0]]) - lead_pad)
    e_idx = min(len(pcm), int(starts[voiced[-1]] + win) + tail_pad)
    clipped = pcm[s_idx:e_idx].astype(np.float32)

    fade_in = min(int(sr * 0.012), len(clipped) // 4)
    fade_out = min(int(sr * 0.020), len(clipped) // 4)
    if fade_in > 1:
        curve = 0.5 * (1.0 - np.cos(np.linspace(0, math.pi, fade_in)))
        clipped[:fade_in] *= curve
    if fade_out > 1:
        curve = 0.5 * (1.0 + np.cos(np.linspace(0, math.pi, fade_out)))
        clipped[-fade_out:] *= curve

    return np.clip(np.round(clipped), -32768, 32767).astype(np.int16)


def save_mp3(pcm: np.ndarray, sr: int, out_path: str):
    import av

    trimmed = trim_and_fade(pcm, sr)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with av.open(out_path, mode="w", format="mp3") as container:
        stream = container.add_stream("libmp3lame", rate=24000)
        stream.bit_rate = 64000
        stream.layout = "mono"
        resampler = av.AudioResampler(format="s16p", layout="mono", rate=24000)
        frame = av.AudioFrame.from_ndarray(trimmed.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = sr
        for rframe in resampler.resample(frame):
            for packet in stream.encode(rframe):
                container.mux(packet)
        for rframe in resampler.resample(None):
            for packet in stream.encode(rframe):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def syl_score(a: str, b: str) -> float:
    if a == b:
        return 3.0
    if normalize_py(a) == normalize_py(b):
        return 2.4
    if a[:1] == b[:1] or a[-1:] == b[-1:]:
        return 0.6
    return -1.2


def find_quiet_cut(pcm: np.ndarray, sr: int, t_lo: float, t_hi: float):
    n = len(pcm)
    i_lo = max(0, min(n - 1, int(t_lo * sr)))
    i_hi = max(i_lo + 1, min(n, int(t_hi * sr)))
    win = max(1, int(sr * 0.035))  # 35ms silence window
    step = max(1, int(sr * 0.005))

    floats = pcm[i_lo:i_hi].astype(np.float32) / 32768.0
    if len(floats) <= win:
        mid = (i_lo + i_hi) // 2
        rms = float(np.sqrt(np.mean(floats * floats))) if len(floats) else 0.0
        return mid, rms

    sq = floats * floats
    csum = np.concatenate(([0.0], np.cumsum(sq)))
    starts = np.arange(0, len(floats) - win + 1, step)
    rms_arr = np.sqrt((csum[starts + win] - csum[starts]) / win)
    best_k = int(np.argmin(rms_arr))
    best_rms = float(rms_arr[best_k])

    w_start = i_lo + int(starts[best_k])
    w_end = min(n - 1, w_start + win)
    seg = pcm[w_start:w_end]
    # Pick zero-crossing or minimum absolute sample near midpoint of quietest window
    zc = np.where(np.diff(np.signbit(seg)))[0]
    if len(zc) > 0:
        center = len(seg) // 2
        pick = int(zc[np.argmin(np.abs(zc - center))])
        cut = w_start + pick
    else:
        cut = w_start + int(np.argmin(np.abs(seg)))
    return cut, best_rms


_WHISPER_MODEL = None


def get_whisper():
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        from faster_whisper import WhisperModel

        model_name = os.environ.get("WHISPER_MODEL", "small")
        _WHISPER_MODEL = WhisperModel(model_name, device="cpu", compute_type="int8")
    return _WHISPER_MODEL


def split_batch(wav_path: str, spec: list):
    pcm, sr = read_wav_pcm16(wav_path)
    total_sec = len(pcm) / sr
    if total_sec < 0.20:
        return {"saved": [], "failed": [it["index"] for it in spec], "reason": "audio_too_short"}

    if len(spec) == 1:
        if float(np.max(np.abs(pcm))) < 300:
            return {"saved": [], "failed": [spec[0]["index"]], "reason": "silent_audio"}
        syl_cnt = len(text_to_syllables(spec[0]["text"]))
        if syl_cnt >= 6 and total_sec < syl_cnt * 0.11:
            return {"saved": [], "failed": [spec[0]["index"]], "reason": "truncated_single_audio"}
        save_mp3(pcm, sr, spec[0]["out"])
        return {"saved": [spec[0]["index"]], "failed": []}

    # Resample to 16kHz float32 for faster-whisper
    floats = pcm.astype(np.float32) / 32768.0
    if sr != 16000:
        target_len = int(round(len(floats) * 16000 / sr))
        x_old = np.linspace(0.0, 1.0, len(floats), endpoint=False)
        x_new = np.linspace(0.0, 1.0, target_len, endpoint=False)
        audio_16k = np.interp(x_new, x_old, floats).astype(np.float32)
    else:
        audio_16k = floats

    model = get_whisper()
    segments, _ = model.transcribe(
        audio_16k,
        language="zh",
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
    )

    obs = []  # [(syl, start, end)]
    for seg in segments:
        for w in seg.words or []:
            syls = text_to_syllables(w.word)
            if not syls:
                continue
            dur = max(0.01, float(w.end) - float(w.start))
            step = dur / len(syls)
            for idx, s in enumerate(syls):
                obs.append((s, float(w.start) + idx * step, float(w.start) + (idx + 1) * step))

    exp = []  # [(syl, item_pos, local_idx)]
    item_syl_counts = []
    for pos, it in enumerate(spec):
        syls = text_to_syllables(it["text"])
        if not syls:
            syls = ["a"]
        item_syl_counts.append(len(syls))
        for l_idx, s in enumerate(syls):
            exp.append((s, pos, l_idx))

    N, M = len(exp), len(obs)
    if M == 0:
        return {"saved": [], "failed": [it["index"] for it in spec], "reason": "no_speech_recognized"}

    # Global Needleman-Wunsch alignment
    gap = -1.4
    dp = np.zeros((N + 1, M + 1), dtype=np.float32)
    ptr = np.zeros((N + 1, M + 1), dtype=np.uint8)  # 1: diag, 2: up (del), 3: left (ins)
    for i in range(1, N + 1):
        dp[i, 0] = i * gap
        ptr[i, 0] = 2
    for j in range(1, M + 1):
        dp[0, j] = j * gap
        ptr[0, j] = 3

    for i in range(1, N + 1):
        es = exp[i - 1][0]
        for j in range(1, M + 1):
            sc = syl_score(es, obs[j - 1][0])
            d_diag = dp[i - 1, j - 1] + sc
            d_up = dp[i - 1, j] + gap
            d_left = dp[i, j - 1] + gap
            if d_diag >= d_up and d_diag >= d_left:
                dp[i, j] = d_diag
                ptr[i, j] = 1
            elif d_up >= d_left:
                dp[i, j] = d_up
                ptr[i, j] = 2
            else:
                dp[i, j] = d_left
                ptr[i, j] = 3

    # Backtrack
    i, j = N, M
    item_matches = [[] for _ in spec]  # list of (obs_idx, score, local_idx)
    while i > 0 or j > 0:
        p = ptr[i, j]
        if i > 0 and j > 0 and p == 1:
            sc = syl_score(exp[i - 1][0], obs[j - 1][0])
            if sc > 0:
                item_matches[exp[i - 1][1]].append((j - 1, sc, exp[i - 1][2]))
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or p == 2):
            i -= 1
        else:
            j -= 1

    # Determine valid items & time spans
    K = len(spec)
    item_ok = [False] * K
    t_first = [0.0] * K
    t_last = [0.0] * K
    for pos in range(K):
        matches = item_matches[pos]
        cnt = item_syl_counts[pos]
        min_req = 1 if cnt <= 2 else max(2, int(math.ceil(cnt * 0.55)))
        if len(matches) >= min_req:
            local_idxs = [m[2] for m in matches]
            edge_tol = max(2, int(math.ceil(cnt * 0.30)))
            edges_ok = True if cnt < 6 else (min(local_idxs) < edge_tol and (cnt - 1 - max(local_idxs)) < edge_tol)
            idxs = [m[0] for m in matches]
            t_first[pos] = min(obs[k][1] for k in idxs)
            t_last[pos] = max(obs[k][2] for k in idxs)
            if edges_ok and t_last[pos] > t_first[pos]:
                item_ok[pos] = True

    # Enforce monotonic ordering between consecutive valid items
    for pos in range(K - 1):
        if item_ok[pos] and item_ok[pos + 1]:
            if t_first[pos + 1] < t_last[pos] - 0.12:
                item_ok[pos] = False
                item_ok[pos + 1] = False

    # Compute cut points between consecutive items
    cuts = [0] * (K + 1)
    cuts[0] = 0
    cuts[K] = len(pcm)
    boundary_ok = [True] * (K + 1)

    for b in range(1, K):
        if not (item_ok[b - 1] and item_ok[b]):
            boundary_ok[b] = False
            continue
        lo = t_last[b - 1] - 0.06
        hi = t_first[b] + 0.06
        if hi <= lo + 0.03:
            mid = 0.5 * (t_last[b - 1] + t_first[b])
            lo, hi = mid - 0.10, mid + 0.10
        cut_sample, min_rms = find_quiet_cut(pcm, sr, lo, hi)
        # Ensure we didn't cut right through loud speech
        if min_rms > 0.09:
            boundary_ok[b] = False
        else:
            cuts[b] = cut_sample

    saved, failed = [], []
    for pos, it in enumerate(spec):
        if not (item_ok[pos] and boundary_ok[pos] and boundary_ok[pos + 1]):
            failed.append(it["index"])
            continue
        seg_pcm = pcm[cuts[pos]:cuts[pos + 1]]
        if len(seg_pcm) < int(sr * 0.18):
            failed.append(it["index"])
            continue
        save_mp3(seg_pcm, sr, it["out"])
        saved.append(it["index"])

    return {"saved": saved, "failed": failed}


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--worker":
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            req = json.loads(line)
            res = split_batch(req["wav"], req["spec"])
            print(json.dumps(res, ensure_ascii=False), flush=True)
        return
    if len(sys.argv) != 3:
        print("Usage: split-batch.py <wav_path> <spec_json_path> | --worker", file=sys.stderr)
        sys.exit(2)
    wav_path, spec_path = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    res = split_batch(wav_path, spec)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
