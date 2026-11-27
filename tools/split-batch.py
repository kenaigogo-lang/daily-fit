#!/usr/bin/env python3
"""
將 Gemini TTS 產生的單段或多段合併 WAV 音檔，精準切分、壓縮過長句中停頓、
去頭尾多餘空白，並支援將多段無損 WAV 片段無縫拼接成單一 MP3（避免瀏覽器分段播放卡頓或被截斷）。
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

    cleaned = re.sub(r"<[^>]+>", "", text)
    expanded = expand_numbers(cleaned)
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


def write_wav_pcm16(pcm: np.ndarray, sr: int, out_path: str):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(np.asarray(pcm, dtype=np.int16).tobytes())


def compress_internal_silences(
    pcm: np.ndarray, sr: int, max_pause_sec: float = 0.30, target_pause_sec: float = 0.20
) -> np.ndarray:
    """將單句內部意外過長的空白（例如 >0.30s）平滑壓縮為自然的 0.20s，讓講解一口氣更順暢。"""
    if len(pcm) < int(sr * 0.6):
        return pcm
    hop = max(1, int(sr * 0.010))  # 10ms frame
    n_frames = len(pcm) // hop
    if n_frames < 20:
        return pcm
    floats = pcm[: n_frames * hop].astype(np.float32) / 32768.0
    rms = np.sqrt(np.mean(floats.reshape(n_frames, hop) ** 2, axis=1))
    peak = float(np.max(rms)) if len(rms) else 0.0
    thresh = max(0.008, min(0.025, peak * 0.06))
    voiced = np.where(rms >= thresh)[0]
    if len(voiced) < 2:
        return pcm

    first_v, last_v = int(voiced[0]), int(voiced[-1])
    max_frames = int(round(max_pause_sec / 0.010))
    keep_half = max(1, int(round((target_pause_sec / 2.0) * sr)))
    xfade = min(int(sr * 0.015), keep_half // 2)

    # 找出介於頭尾人聲之間、連續超過 max_frames 的靜音區段
    cuts = []
    f = first_v
    while f <= last_v:
        if rms[f] < thresh:
            s = f
            while f <= last_v and rms[f] < thresh:
                f += 1
            if (f - s) > max_frames:
                s_samp = s * hop
                e_samp = f * hop
                if (e_samp - s_samp) > (2 * keep_half + xfade):
                    cuts.append((s_samp, e_samp))
        else:
            f += 1

    if not cuts:
        return pcm

    parts = []
    cursor = 0
    for s_samp, e_samp in cuts:
        left_end = s_samp + keep_half
        right_start = e_samp - keep_half
        parts.append(pcm[cursor : left_end - xfade].astype(np.float32))
        if xfade > 1:
            a = pcm[left_end - xfade : left_end].astype(np.float32)
            b = pcm[right_start : right_start + xfade].astype(np.float32)
            w = 0.5 * (1.0 - np.cos(np.linspace(0, math.pi, xfade)))
            parts.append(a * (1.0 - w) + b * w)
        cursor = right_start + xfade
    parts.append(pcm[cursor:].astype(np.float32))
    out = np.concatenate(parts)
    return np.clip(np.round(out), -32768, 32767).astype(np.int16)


def trim_and_fade(
    pcm: np.ndarray,
    sr: int,
    lead_ms: int = 45,
    tail_ms: int = 95,
    fade_in_ms: int = 10,
    fade_out_ms: int = 18,
    compress_pauses: bool = True,
) -> np.ndarray:
    if len(pcm) == 0:
        return pcm
    if compress_pauses:
        pcm = compress_internal_silences(pcm, sr)

    win = max(1, int(sr * 0.015))  # 15ms frame
    hop = max(1, int(sr * 0.005))  # 5ms hop
    floats = pcm.astype(np.float32) / 32768.0
    if len(floats) < win:
        return pcm

    sq = floats * floats
    csum = np.concatenate(([0.0], np.cumsum(sq)))
    starts = np.arange(0, len(floats) - win + 1, hop)
    rms = np.sqrt((csum[starts + win] - csum[starts]) / win)

    peak = float(np.max(rms)) if len(rms) else 0.0
    thresh = max(0.006, min(0.025, peak * 0.06))
    voiced = np.where(rms >= thresh)[0]
    if len(voiced) == 0:
        return pcm

    lead_pad = int(sr * lead_ms / 1000.0)
    tail_pad = int(sr * tail_ms / 1000.0)
    s_idx = max(0, int(starts[voiced[0]]) - lead_pad)
    e_idx = min(len(pcm), int(starts[voiced[-1]] + win) + tail_pad)
    clipped = pcm[s_idx:e_idx].astype(np.float32)

    fade_in = min(int(sr * fade_in_ms / 1000.0), len(clipped) // 4)
    fade_out = min(int(sr * fade_out_ms / 1000.0), len(clipped) // 4)
    if fade_in > 1:
        curve = 0.5 * (1.0 - np.cos(np.linspace(0, math.pi, fade_in)))
        clipped[:fade_in] *= curve
    if fade_out > 1:
        curve = 0.5 * (1.0 + np.cos(np.linspace(0, math.pi, fade_out)))
        clipped[-fade_out:] *= curve

    return np.clip(np.round(clipped), -32768, 32767).astype(np.int16)


def encode_mp3(pcm: np.ndarray, sr: int, out_path: str, bit_rate: int = 48000):
    import av

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with av.open(out_path, mode="w", format="mp3") as container:
        stream = container.add_stream("libmp3lame", rate=24000)
        stream.bit_rate = bit_rate
        stream.layout = "mono"
        resampler = av.AudioResampler(format="s16p", layout="mono", rate=24000)
        frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = sr
        for rframe in resampler.resample(frame):
            for packet in stream.encode(rframe):
                container.mux(packet)
        for rframe in resampler.resample(None):
            for packet in stream.encode(rframe):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def save_clip(pcm: np.ndarray, sr: int, out_path: str):
    if out_path.lower().endswith(".wav"):
        # 中間無損暫存片段：先壓縮過長停頓並緊密裁切，保留無損音質供後續拼接
        trimmed = trim_and_fade(pcm, sr, lead_ms=22, tail_ms=42, fade_in_ms=8, fade_out_ms=12, compress_pauses=True)
        write_wav_pcm16(trimmed, sr, out_path)
    else:
        trimmed = trim_and_fade(pcm, sr, lead_ms=45, tail_ms=95, fade_in_ms=10, fade_out_ms=18, compress_pauses=True)
        encode_mp3(trimmed, sr, out_path)


def stitch_clips(inputs: list, out_path: str):
    """將多段無損 WAV 片段依指定間隔無縫接成單一 MP3。"""
    sr = 24000
    pieces = []
    for idx, item in enumerate(inputs):
        pcm, file_sr = read_wav_pcm16(item["wav"])
        if file_sr != sr:
            target_len = int(round(len(pcm) * sr / file_sr))
            x_old = np.linspace(0.0, 1.0, len(pcm), endpoint=False)
            x_new = np.linspace(0.0, 1.0, target_len, endpoint=False)
            pcm = np.interp(x_new, x_old, pcm.astype(np.float32)).astype(np.int16)
        pieces.append(pcm)
        gap_ms = int(item.get("gap_after_ms", 0))
        if idx < len(inputs) - 1 and gap_ms > 0:
            pieces.append(np.zeros(int(sr * gap_ms / 1000.0), dtype=np.int16))

    if not pieces:
        return {"ok": False, "reason": "empty_inputs"}

    # 外圍加上自然淡入淡出與適度頭尾留白
    pad_head = np.zeros(int(sr * 0.025), dtype=np.int16)
    pad_tail = np.zeros(int(sr * 0.060), dtype=np.int16)
    combined = np.concatenate([pad_head, *pieces, pad_tail])
    encode_mp3(combined, sr, out_path)
    return {"ok": True, "sec": round(len(combined) / sr, 2)}


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
    win = max(1, int(sr * 0.035))
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
        save_clip(pcm, sr, spec[0]["out"])
        return {"saved": [spec[0]["index"]], "failed": []}

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

    obs = []
    for seg in segments:
        for w in seg.words or []:
            syls = text_to_syllables(w.word)
            if not syls:
                continue
            dur = max(0.01, float(w.end) - float(w.start))
            step = dur / len(syls)
            for idx, s in enumerate(syls):
                obs.append((s, float(w.start) + idx * step, float(w.start) + (idx + 1) * step))

    exp = []
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

    gap = -1.4
    dp = np.zeros((N + 1, M + 1), dtype=np.float32)
    ptr = np.zeros((N + 1, M + 1), dtype=np.uint8)
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

    i, j = N, M
    item_matches = [[] for _ in spec]
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

    for pos in range(K - 1):
        if item_ok[pos] and item_ok[pos + 1]:
            if t_first[pos + 1] < t_last[pos] - 0.12:
                item_ok[pos] = False
                item_ok[pos + 1] = False

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
        if min_rms > 0.09:
            boundary_ok[b] = False
        else:
            cuts[b] = cut_sample

    saved, failed = [], []
    for pos, it in enumerate(spec):
        if not (item_ok[pos] and boundary_ok[pos] and boundary_ok[pos + 1]):
            failed.append(it["index"])
            continue
        seg_pcm = pcm[cuts[pos] : cuts[pos + 1]]
        if len(seg_pcm) < int(sr * 0.18):
            failed.append(it["index"])
            continue
        save_clip(seg_pcm, sr, it["out"])
        saved.append(it["index"])

    return {"saved": saved, "failed": failed}


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--worker":
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            req = json.loads(line)
            if req.get("cmd") == "stitch":
                res = stitch_clips(req["inputs"], req["out"])
            else:
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
