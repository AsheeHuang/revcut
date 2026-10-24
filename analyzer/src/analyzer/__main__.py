import argparse
import json
import platform


def doctor() -> dict:
    return {"ok": True, "python": platform.python_version()}


def main() -> None:
    parser = argparse.ArgumentParser(prog="analyzer")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="檢查 analyzer 環境")
    args = parser.parse_args()
    if args.command == "doctor":
        print(json.dumps(doctor()))


if __name__ == "__main__":
    main()
