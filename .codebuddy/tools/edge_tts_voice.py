#!/usr/bin/env python3
"""Generate single or batch MP3 speech files with Microsoft Edge online TTS."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import edge_tts
except ImportError as error:
    raise SystemExit(
        "缺少 edge-tts。请运行：python -m pip install --user edge-tts"
    ) from error


DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_RATE = "+15%"
DEFAULT_VOLUME = "+0%"
DEFAULT_PITCH = "+6Hz"
SAFE_MP3 = re.compile(r"^[A-Za-z0-9._-]+\.mp3$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="使用 Microsoft Edge 在线 TTS 生成 MP3 语音或批量语音包。"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--text", help="直接提供要朗读的文字")
    source.add_argument("--text-file", type=Path, help="UTF-8 文本文件")
    source.add_argument("--batch-json", type=Path, help="批量任务 JSON 文件")
    source.add_argument("--list-voices", action="store_true", help="列出在线声音")
    parser.add_argument("--output", type=Path, help="单条语音的 MP3 输出路径")
    parser.add_argument("--output-dir", type=Path, help="批量语音包输出目录")
    parser.add_argument("--manifest", type=Path, help="批量 manifest 输出路径")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--rate", default=DEFAULT_RATE)
    parser.add_argument("--volume", default=DEFAULT_VOLUME)
    parser.add_argument("--pitch", default=DEFAULT_PITCH)
    parser.add_argument("--locale", help="列出声音时仅保留指定语言，如 zh-CN")
    parser.add_argument("--force", action="store_true", help="重新生成已存在的同配置音频")
    return parser.parse_args()


def nonempty_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} 不能为空")
    return value.strip()


def deterministic_name(text: str, profile: dict[str, str]) -> str:
    payload = json.dumps(
        {"text": text, **profile}, ensure_ascii=False, sort_keys=True
    ).encode("utf-8")
    return f"{hashlib.sha256(payload).hexdigest()[:24]}.mp3"


def migrate_legacy_endpoint(error: Exception) -> None:
    """Use Edge's current synthesis host after a legacy-host HTTP 403."""
    if getattr(error, "status", None) != 403:
        return
    from edge_tts import communicate
    from edge_tts.constants import TRUSTED_CLIENT_TOKEN

    if not communicate.WSS_URL.startswith("wss://speech.platform.bing.com/"):
        return
    # Compatibility for edge-tts 7.2.8; preserve TLS checks and voice settings.
    # https://github.com/rany2/edge-tts/pull/491
    communicate.WSS_URL = (
        "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
        f"?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}"
    )
    print("旧版语音接口返回 403，已切换到 Edge 当前语音接口重试。", file=sys.stderr)


async def synthesize(
    text: str,
    destination: Path,
    profile: dict[str, str],
    force: bool,
) -> None:
    if destination.exists() and destination.stat().st_size > 0 and not force:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    if temporary.exists():
        temporary.unlink()

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            communicator = edge_tts.Communicate(
                text,
                profile["voice"],
                rate=profile["rate"],
                volume=profile["volume"],
                pitch=profile["pitch"],
            )
            await communicator.save(str(temporary))
            if not temporary.exists() or temporary.stat().st_size == 0:
                raise RuntimeError("在线服务返回了空音频")
            temporary.replace(destination)
            return
        except Exception as error:  # Network and service errors vary by version.
            last_error = error
            migrate_legacy_endpoint(error)
            if temporary.exists():
                temporary.unlink()
            if attempt < 2:
                await asyncio.sleep(1 + attempt)
    raise RuntimeError(f"生成语音失败：{last_error}") from last_error


def profile_from(values: dict[str, Any], defaults: dict[str, str]) -> dict[str, str]:
    return {
        key: nonempty_text(values.get(key, defaults[key]), key)
        for key in ("voice", "rate", "volume", "pitch")
    }


async def generate_single(args: argparse.Namespace) -> None:
    if args.output is None or args.output.suffix.lower() != ".mp3":
        raise ValueError("单条生成必须提供以 .mp3 结尾的 --output")
    text = args.text
    if args.text_file:
        text = args.text_file.read_text(encoding="utf-8")
    profile = profile_from(
        vars(args),
        {
            "voice": DEFAULT_VOICE,
            "rate": DEFAULT_RATE,
            "volume": DEFAULT_VOLUME,
            "pitch": DEFAULT_PITCH,
        },
    )
    await synthesize(
        nonempty_text(text, "text"), args.output.resolve(), profile, args.force
    )
    print(json.dumps({"output": str(args.output.resolve()), **profile}, ensure_ascii=False))


async def generate_batch(args: argparse.Namespace) -> None:
    if args.output_dir is None:
        raise ValueError("批量生成必须提供 --output-dir")
    payload = json.loads(args.batch_json.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("clips"), list):
        raise ValueError("批量 JSON 必须是包含 clips 数组的对象")

    defaults = profile_from(
        payload,
        {
            "voice": args.voice,
            "rate": args.rate,
            "volume": args.volume,
            "pitch": args.pitch,
        },
    )
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_clips: dict[str, dict[str, str]] = {}

    for index, clip in enumerate(payload["clips"], start=1):
        if not isinstance(clip, dict):
            raise ValueError(f"第 {index} 条 clip 必须是对象")
        text = nonempty_text(clip.get("text"), f"第 {index} 条 text")
        profile = profile_from(clip, defaults)
        file_name = clip.get("fileName") or deterministic_name(text, profile)
        if not isinstance(file_name, str) or not SAFE_MP3.fullmatch(file_name):
            raise ValueError(f"第 {index} 条 fileName 只能使用安全的 .mp3 文件名")
        await synthesize(text, output_dir / file_name, profile, args.force)
        manifest_clips[text] = {"fileName": file_name, **profile}
        print(f"已完成 {index}/{len(payload['clips'])}：{text}")

    manifest_path = (
        args.manifest.resolve() if args.manifest else output_dir / "manifest.json"
    )
    manifest = {
        "schemaVersion": 1,
        "provider": "Microsoft Edge Online TTS (edge-tts)",
        "edgeTtsVersion": getattr(edge_tts, "__version__", "unknown"),
        "clips": manifest_clips,
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"语音包完成：{len(manifest_clips)} 条，manifest={manifest_path}")


async def list_voices(locale: str | None) -> None:
    voices = await edge_tts.list_voices()
    selected = [
        voice
        for voice in voices
        if not locale or voice.get("Locale", "").lower() == locale.lower()
    ]
    print(json.dumps(selected, ensure_ascii=False, indent=2))


async def main() -> None:
    args = parse_args()
    if args.list_voices:
        await list_voices(args.locale)
    elif args.batch_json:
        await generate_batch(args)
    else:
        await generate_single(args)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        print(f"错误：{error}", file=sys.stderr)
        raise SystemExit(1) from error
