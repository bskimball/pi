#!/usr/bin/env python
"""Generate images via the local proxy /v1/images/generations with model fallback.

Usage:
  python generate_image.py "prompt text" [--out PATH] [--size WxH] [--n N] [--model MODEL]

Tries models in order: gpt-image-2, grok-imagine-image, gpt-image-1.5
(or a single --model if given). Saves PNG(s) and prints saved paths.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "http://localhost:8317/v1/images/generations"
API_KEY_ENV = "PI_LOCAL_PROXY_API_KEY"
FALLBACK_CHAIN = ["grok-imagine-image", "gpt-image-2", "gpt-image-1.5"]
RETRIES_PER_MODEL = 2
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_metadata(header, byte_size=None):
    """Validate a PNG header and return bounded artifact metadata."""
    size = len(header) if byte_size is None else byte_size
    if size <= 0:
        raise RuntimeError("PNG is empty")
    if len(header) < 24 or header[:8] != PNG_SIGNATURE:
        raise RuntimeError("invalid PNG signature or truncated header")
    if header[8:12] != b"\x00\x00\x00\r" or header[12:16] != b"IHDR":
        raise RuntimeError("PNG is missing a valid IHDR chunk")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width <= 0 or height <= 0:
        raise RuntimeError("PNG has invalid dimensions")
    return width, height, size


def validate_png_file(path):
    artifact = Path(path)
    if not artifact.is_file():
        raise RuntimeError(f"PNG was not written: {path}")
    size = artifact.stat().st_size
    with artifact.open("rb") as f:
        header = f.read(24)
    return png_metadata(header, size)


def decode_image_batch(items, requested_n):
    """Decode and validate a complete response batch before any output write."""
    if requested_n < 1:
        raise RuntimeError("requested image count must be at least 1")
    if not isinstance(items, list) or len(items) != requested_n:
        count = len(items) if isinstance(items, list) else "non-list"
        raise RuntimeError(
            f"API returned {count} image(s); expected {requested_n}"
        )

    images = []
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError("unexpected non-object image item")
        if "b64_json" in item:
            try:
                raw = base64.b64decode(item["b64_json"], validate=True)
            except (ValueError, TypeError) as e:
                raise RuntimeError(f"invalid base64 image data: {e}") from e
        elif "url" in item:
            with urllib.request.urlopen(item["url"], timeout=120) as response:
                raw = response.read()
        else:
            raise RuntimeError(f"unexpected item keys: {list(item)}")
        png_metadata(raw[:24], len(raw))
        images.append(raw)
    return images


def get_api_key():
    api_key = os.environ.get(API_KEY_ENV)
    if api_key:
        return api_key

    models_path = Path.home() / ".pi" / "agent" / "models.json"
    try:
        models = json.loads(models_path.read_text(encoding="utf-8"))
        api_key = models["providers"]["local-proxy"]["apiKey"]
        if api_key:
            return api_key
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        pass

    raise RuntimeError(
        f"Local proxy API key not found in {models_path} or {API_KEY_ENV}"
    )


def request_images(model, prompt, size, n, timeout=180):
    api_key = get_api_key()
    body = {"model": model, "prompt": prompt, "n": n}
    if size:
        body["size"] = size
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    if "error" in data:
        raise RuntimeError(data["error"].get("message", str(data["error"])))
    return data["data"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("prompt")
    p.add_argument("--out", default="image.png", help="Output path (suffix _2, _3 added for n>1)")
    p.add_argument("--size", default=None, help="e.g. 1024x1024, 1536x1024, 1024x1536")
    p.add_argument("--n", type=int, default=1)
    p.add_argument("--model", default=None, help="Use only this model (no fallback)")
    args = p.parse_args()

    models = [args.model] if args.model else FALLBACK_CHAIN
    last_err = None
    for model in models:
        for attempt in range(1, RETRIES_PER_MODEL + 1):
            try:
                items = request_images(model, args.prompt, args.size, args.n)
                images = decode_image_batch(items, args.n)
                artifacts = []
                for i, raw in enumerate(images):
                    path = args.out
                    if i > 0:
                        stem, dot, ext = args.out.rpartition(".")
                        path = f"{stem}_{i + 1}{dot}{ext}" if dot else f"{args.out}_{i + 1}"
                    with open(path, "wb") as f:
                        f.write(raw)
                    width, height, byte_size = validate_png_file(path)
                    artifacts.append((path, width, height, byte_size))
                print(f"model: {model}")
                for path, width, height, byte_size in artifacts:
                    print(f"saved: {path}")
                    print(f"png: {width}x{height}, {byte_size} bytes")
                return 0
            except (RuntimeError, urllib.error.URLError, OSError, json.JSONDecodeError) as e:
                if isinstance(e, urllib.error.HTTPError):
                    try:
                        detail = json.load(e).get("error", {}).get("message", "")
                    except Exception:
                        detail = ""
                    e = RuntimeError(f"HTTP {e.code}: {detail}")
                last_err = e
                print(f"[{model} attempt {attempt}] failed: {e}", file=sys.stderr)
                if attempt < RETRIES_PER_MODEL:
                    time.sleep(2)
    print(f"error: all models failed. Last error: {last_err}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
