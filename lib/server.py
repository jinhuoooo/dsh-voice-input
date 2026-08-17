#!/usr/bin/env python3
"""
DSH voice-input: persistent Whisper transcription server (v2.1).

Loads the Whisper model ONCE at startup, then serves transcription requests
over a line-based stdin/stdout protocol. This removes the per-request model
load that made the one-shot flow slow and memory-heavy.

Protocol (UTF-8, one JSON per line, LF-terminated):
  Server → "READY\n"                        (model loaded, ready for work)
  Client → {"file": "<wav path>", "lang": "zh"}\n
  Server → {"text": "..."}\n                (success)
  Server → {"error": "..."}\n               (failure)
  Server → "IDLE_EXIT\n"                    (idle timeout; process exits)

Lifespan:
  - stdin EOF (parent died)   → exit immediately
  - idle timeout (default 30min) → exit to release RAM
  - one request at a time (client serializes)

Config via environment variables (same as transcribe.py):
  DSH_WHISPER_MODEL     model size: tiny|base|small|medium|large-v3 (default: small)
  DSH_WHISPER_LANG      language code (default: zh)
  DSH_WHISPER_DEVICE    cpu|cuda (default: cpu)
  DSH_WHISPER_COMPUTE   int8|float16|float32 (default: int8)
  DSH_WHISPER_CACHE     model cache dir (default: ~/.dsh/whisper_models)
  DSH_WHISPER_IDLE_TIMEOUT  seconds to stay alive while idle (default: 1800)
"""

import sys
import os
import json
import time
import subprocess
import threading

# ── Force UTF-8 on stdout/stderr (Windows GBK pipes → garbled text) ──
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DEFAULT_CACHE_DIR = os.path.join(os.path.expanduser("~"), ".dsh", "whisper_models")

# Model mapping: faster-whisper model size -> ModelScope repo ID
MODELSCOPE_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "medium.en": "Systran/faster-whisper-medium.en",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
}

# Chinese speech prompt: nudges Whisper toward 普通话 short-form dictation
DEFAULT_PROMPT = "以下是普通话口述内容，请直接转写为简体中文。"

# ── Simplified-Chinese normalizer ───────────────────────────────
# Whisper sometimes emits traditional characters for zh; convert to
# simplified so the transcript matches what the user expects.
_OPENCC_CACHE = {}


def to_simplified(text):
    if not text:
        return text
    try:
        cc = _OPENCC_CACHE.get("t2s")
        if cc is None:
            from opencc import OpenCC
            cc = OpenCC("t2s")
            _OPENCC_CACHE["t2s"] = cc
        return cc.convert(text)
    except Exception:
        # opencc unavailable → best-effort initial_prompt already nudged it
        return text


def ensure_faster_whisper():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        print("INSTALLING", file=sys.stderr, flush=True)
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "faster-whisper",
                 "--quiet", "--disable-pip-version-check",
                 "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:  # noqa: BLE001
            print(
                "ERROR: faster-whisper 安装失败。请手动执行:\n  %s -m pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple"
                % sys.executable,
                file=sys.stderr, flush=True,
            )
            sys.exit(3)
        from faster_whisper import WhisperModel
        return WhisperModel


def ensure_modelscope():
    try:
        from modelscope import snapshot_download
        return snapshot_download
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "modelscope",
                 "--quiet", "--disable-pip-version-check",
                 "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:  # noqa: BLE001
            return None
        from modelscope import snapshot_download
        return snapshot_download


def get_model_path(model_size, cache_dir):
    """Resolve local model path; download from ModelScope if needed."""
    if os.path.isdir(model_size):
        return model_size
    repo_id = MODELSCOPE_REPOS.get(model_size, f"Systran/faster-whisper-{model_size}")
    safe_repo = repo_id.replace("/", "--")
    cached_path = os.path.join(cache_dir, "models", safe_repo, "snapshots", "master")
    if os.path.isdir(cached_path) and os.path.exists(os.path.join(cached_path, "model.bin")):
        return cached_path
    print("DOWNLOADING", file=sys.stderr, flush=True)
    sd = ensure_modelscope()
    if sd is None:
        raise RuntimeError("无法从 ModelScope 下载模型（modelscope 安装失败）")
    return sd(repo_id, cache_dir=cache_dir)


def load_model():
    if not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    model_size = os.environ.get("DSH_WHISPER_MODEL", "small")
    device = os.environ.get("DSH_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("DSH_WHISPER_COMPUTE", "int8")
    cache_dir = os.environ.get("DSH_WHISPER_CACHE", DEFAULT_CACHE_DIR)

    WhisperModel = ensure_faster_whisper()
    model_path = get_model_path(model_size, cache_dir)
    model = WhisperModel(model_path, device=device, compute_type=compute_type)
    return model, model_size


def transcribe_file(model, path, lang):
    """Run transcription with speed-optimized parameters. Returns text."""
    segments, _info = model.transcribe(
        path,
        language=lang,
        beam_size=1,                # greedy decoding ≈ 2x faster, negligible loss for short dictation
        temperature=0,
        vad_filter=True,            # skip silence → faster + no hallucination
        vad_parameters=dict(
            min_silence_duration_ms=500,
            speech_pad_ms=200,
        ),
        condition_on_previous_text=False,  # short-form speech; avoids slow re-scoring
        initial_prompt=DEFAULT_PROMPT,
        # Anti-hallucination guards: reject low-confidence / no-speech output
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )
    text = "".join(segment.text for segment in segments).strip()
    return to_simplified(text)


def main():
    idle_timeout = float(os.environ.get("DSH_WHISPER_IDLE_TIMEOUT", "1800"))
    language = os.environ.get("DSH_WHISPER_LANG", "zh")

    print("LOADING", file=sys.stderr, flush=True)
    model, model_size = load_model()
    print(f"MODEL_LOADED {model_size}", file=sys.stderr, flush=True)
    print("READY", flush=True)

    last_activity = time.time()
    stdin_lock = threading.Lock()  # single-line reader (unused but documented)

    # Watchdog: exit after idle timeout to release ~1GB+ of RAM
    def idle_watchdog():
        while True:
            time.sleep(10)
            if time.time() - last_activity > idle_timeout:
                try:
                    print("IDLE_EXIT", flush=True)
                except Exception:
                    pass
                os._exit(0)

    if idle_timeout > 0:
        threading.Thread(target=idle_watchdog, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        last_activity = time.time()
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"bad request: {exc}"}), flush=True)
            continue

        audio_path = req.get("file") or ""
        lang = req.get("lang") or language
        if not audio_path or not os.path.exists(audio_path):
            print(json.dumps({"error": f"audio file not found: {audio_path}"}), flush=True)
            continue

        try:
            text = transcribe_file(model, audio_path, lang)
            print(json.dumps({"text": text}, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"error": str(exc)}, ensure_ascii=False), flush=True)

    # stdin closed → parent died → clean exit
    os._exit(0)


if __name__ == "__main__":
    main()
