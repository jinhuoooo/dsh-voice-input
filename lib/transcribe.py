#!/usr/bin/env python3
"""
Local Whisper transcription for DSH voice input plugin.

Reads audio binary from stdin, transcribes with faster-whisper, prints text to stdout.
Auto-installs faster-whisper on first run.
Downloads models from ModelScope (accessible in China) instead of HuggingFace.

Config via environment variables:
  DSH_WHISPER_MODEL     - model size: tiny|base|small|medium|large-v3 (default: medium)
  DSH_WHISPER_LANG      - language code: zh|en|ja|... (default: zh)
  DSH_WHISPER_DEVICE    - cpu|cuda (default: cpu)
  DSH_WHISPER_COMPUTE   - int8|float16|float32 (default: int8)
  DSH_WHISPER_CACHE     - model cache directory (default: ~/.dsh/whisper_models)
"""

import sys
import os
import tempfile
import subprocess
import traceback

# ── Force UTF-8 on stdout/stderr ────────────────────────────────
# Windows pipes default to the locale encoding (GBK), which Node.js decodes
# as UTF-8 → garbled text (问号方块). Reconfigure to UTF-8 explicitly.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Model cache directory
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

_OPENCC_CACHE = {}


def to_simplified(text):
    """Convert traditional → simplified Chinese (best-effort)."""
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
        return text


def ensure_faster_whisper():
    """Import faster_whisper, auto-install if missing."""
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
        except Exception as exc:  # noqa: BLE001
            print(
                "ERROR: faster-whisper 安装失败。当前 Python 版本可能过旧，"
                "请手动执行以下命令安装:\n  %s -m pip install faster-whisper -i https://pypi.tuna.tsinghua.edu.cn/simple"
                % sys.executable,
                file=sys.stderr, flush=True,
            )
            sys.exit(3)
        from faster_whisper import WhisperModel
        return WhisperModel


def ensure_modelscope():
    """Import modelscope, auto-install if missing."""
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
        except Exception as exc:  # noqa: BLE001
            print(
                "ERROR: modelscope 安装失败（%s）。模型将改从 HuggingFace 镜像下载，"
                "如无法访问请手动安装: %s -m pip install modelscope" % (exc, sys.executable),
                file=sys.stderr, flush=True,
            )
            return None
        from modelscope import snapshot_download
        return snapshot_download


def download_model(model_size, cache_dir):
    """Download model from ModelScope, return local path."""
    repo_id = MODELSCOPE_REPOS.get(model_size, f"Systran/faster-whisper-{model_size}")
    snapshot_download = ensure_modelscope()
    if snapshot_download is None:
        raise RuntimeError("无法从 ModelScope 下载模型（modelscope 安装失败），请检查网络")
    model_path = snapshot_download(repo_id, cache_dir=cache_dir)
    return model_path


def get_model_path(model_size, cache_dir):
    """Get local model path, downloading from ModelScope if needed."""
    # Check if it's already a local path
    if os.path.isdir(model_size):
        return model_size

    # Check ModelScope cache
    repo_id = MODELSCOPE_REPOS.get(model_size, f"Systran/faster-whisper-{model_size}")
    # ModelScope cache structure: cache_dir/models/<repo_id with -->/snapshots/<revision>
    safe_repo = repo_id.replace("/", "--")
    cached_path = os.path.join(cache_dir, "models", safe_repo, "snapshots", "master")
    if os.path.isdir(cached_path) and os.path.exists(os.path.join(cached_path, "model.bin")):
        return cached_path

    # Download from ModelScope
    print("DOWNLOADING", file=sys.stderr, flush=True)
    return download_model(model_size, cache_dir)


def main():
    # Use HF mirror as fallback (in case modelscope fails and HF is accessible)
    if not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

    # Read audio binary from stdin
    audio_data = sys.stdin.buffer.read()
    if not audio_data or len(audio_data) < 100:
        print("")
        return

    # Config from environment
    model_size = os.environ.get("DSH_WHISPER_MODEL", "medium")
    language = os.environ.get("DSH_WHISPER_LANG", "zh")
    device = os.environ.get("DSH_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("DSH_WHISPER_COMPUTE", "int8")
    cache_dir = os.environ.get("DSH_WHISPER_CACHE", DEFAULT_CACHE_DIR)

    # Detect audio format from magic bytes
    if audio_data[:4] == b'OggS':
        suffix = '.ogg'
    elif audio_data[:4] == b'RIFF':
        suffix = '.wav'
    elif audio_data[:4] == b'\x1aE\xdf\xa3':
        suffix = '.webm'
    elif audio_data[4:8] == b'ftyp':
        suffix = '.m4a'
    else:
        suffix = '.webm'

    # Write audio to temp file
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(audio_data)

        # Signal: loading model
        print("LOADING", file=sys.stderr, flush=True)

        WhisperModel = ensure_faster_whisper()

        # Get model path (download from ModelScope if needed)
        model_path = get_model_path(model_size, cache_dir)

        model = WhisperModel(model_path, device=device, compute_type=compute_type)

        # Signal: transcribing
        print("TRANSCRIBING", file=sys.stderr, flush=True)

        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=1,                # greedy decoding ≈ 2x faster than beam=5
            temperature=0,
            vad_filter=True,
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
        print(to_simplified(text))

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        print("")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
