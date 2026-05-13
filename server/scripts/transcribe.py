#!/usr/bin/env python3
# Transcribes an audio file using faster-whisper and prints the transcript to stdout.
# Usage: transcribe.py <audio_file_path> [model_size]
# Model sizes: tiny, base, small, medium (default: base)
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file> [model_size]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    if not os.path.exists(audio_path):
        print(f"File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio_path, beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    print(text)

if __name__ == "__main__":
    main()
