"""Entry point: `python -m bench --config bench.toml`.

Loads a bench TOML config and runs the daemon. The pairing token is printed
once to stdout; paste it into the browser's optical-mode settings.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from bench.config import load_config
from bench.daemon import serve
from bench.pairing import Pairing


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, load the config, and run the daemon to completion."""
    parser = argparse.ArgumentParser(prog="bench", description="qvc BB84 bench daemon")
    parser.add_argument("--config", required=True, help="path to a bench TOML config")
    parser.add_argument(
        "--pairing-token-file",
        help="also write the pairing token to this file (for automated tests)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    try:
        cfg = load_config(args.config)
    except (OSError, ValueError) as exc:
        print(f"config error: {exc}", file=sys.stderr)  # noqa: T201 - startup diagnostic
        return 2

    # Pre-mint the token so an automated harness can read it before the server
    # races ahead; the human path just reads it from the log serve() emits.
    pairing = Pairing()
    if args.pairing_token_file:
        Path(args.pairing_token_file).write_text(pairing.token, encoding="utf-8")

    try:
        asyncio.run(serve(cfg, pairing=pairing))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
