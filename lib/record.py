#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh-voice-input system-level microphone recorder.

Records from the OS microphone directly (bypasses the DSH webview's
getUserMedia permission problem) and writes 16kHz mono 16-bit PCM WAV.

Usage:
  python record.py --output out.wav [--max-duration 60] [--stop-signal file]

The process keeps recording until:
  - the stop-signal file appears (created by the host), OR
  - --max-duration seconds elapse.

Exit codes:
  0  - recording finished, WAV saved
  2  - no microphone device found
  3  - audio error
"""

import argparse
import os
import sys
import time

# ── Force UTF-8 on stdout/stderr ────────────────────────────────
# Windows pipes default to the locale encoding (GBK), which Node.js decodes
# as UTF-8 → garbled text (问号方块). Reconfigure to UTF-8 explicitly.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def ensure_deps():
    """Make sure sounddevice is importable; auto-install when missing."""
    try:
        import numpy  # noqa: F401
        import sounddevice  # noqa: F401
        return True
    except ImportError:
        pass
    print('INSTALLING', file=sys.stderr)
    try:
        import subprocess
        subprocess.check_call(
            [
                sys.executable, '-m', 'pip', 'install',
                'sounddevice', 'numpy',
                '--quiet', '--disable-pip-version-check',
                '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple',
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        print('AUDIO_ERROR: sounddevice 自动安装失败: %s' % exc, file=sys.stderr)
        return False


def find_input_device():
    """Return an index of a usable input device, or None."""
    import sounddevice as sd
    devices = sd.query_devices()
    idx = sd.default.device[0]
    if idx is None or idx < 0:
        idx = None
        for i, dev in enumerate(devices):
            if dev['max_input_channels'] > 0:
                idx = i
                break
    if idx is None:
        return None
    info = sd.query_devices(idx)
    if info['max_input_channels'] < 1:
        return None
    return idx


def main():
    parser = argparse.ArgumentParser(description='System microphone recorder')
    parser.add_argument('--output', required=True)
    parser.add_argument('--max-duration', type=float, default=60.0)
    parser.add_argument('--stop-signal', default='')
    args = parser.parse_args()

    if not ensure_deps():
        sys.exit(3)

    # Pick a microphone
    try:
        device_idx = find_input_device()
    except Exception as exc:  # noqa: BLE001
        print('AUDIO_ERROR: 麦克风设备检测失败: %s' % exc, file=sys.stderr)
        sys.exit(3)
    if device_idx is None:
        print('NO_DEVICE: 未检测到麦克风设备，请检查系统设置 > 隐私 > 麦克风', file=sys.stderr)
        sys.exit(2)

    import numpy as np
    import sounddevice as sd

    sample_rate = 16000
    frames = []
    last_lvl_at = [0.0]  # last time we emitted a level (throttle to ~10Hz)

    def callback(indata, frames_count, time_info, status):
        frames.append(indata.copy())
        # ── Real-time volume metering ─────────────────────────
        # Emit LVL:<0-100> on stderr at ~10Hz so the host can drive
        # a live mic-level animation in the recording UI.
        now = time.time()
        if now - last_lvl_at[0] >= 0.1:
            last_lvl_at[0] = now
            try:
                rms = float(np.sqrt(np.mean(indata.astype(np.float32) ** 2)))
                # int16 range ≈ 0..32767; speech RMS is typically 300..4000
                lvl = min(100, int(rms / 40.0))
                print('LVL:%d' % lvl, file=sys.stderr, flush=True)
            except Exception:
                pass

    try:
        with sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype='int16',
            device=device_idx,
            callback=callback,
        ):
            start = time.time()
            while time.time() - start < args.max_duration:
                if args.stop_signal and os.path.exists(args.stop_signal):
                    break
                time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # noqa: BLE001
        print('AUDIO_ERROR: 录音失败: %s' % exc, file=sys.stderr)
        sys.exit(3)

    # Assemble WAV (16kHz, mono, 16-bit)
    data = np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)
    import wave
    with wave.open(args.output, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(data.tobytes())

    duration = len(data) / float(sample_rate)
    print('SAVED:%s duration=%.2f' % (args.output, duration), file=sys.stderr)
    sys.exit(0)


if __name__ == '__main__':
    main()
