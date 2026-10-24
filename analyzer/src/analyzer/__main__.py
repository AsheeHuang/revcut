import argparse
import json
import platform


def doctor() -> dict:
    return {"ok": True, "python": platform.python_version()}


def main() -> None:
    parser = argparse.ArgumentParser(prog="analyzer")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="檢查 analyzer 環境")
    beats = commands.add_parser("beats", help="偵測拍點、重拍和音量")
    beats.add_argument("--input", required=True, help="wav 檔")
    args = parser.parse_args()
    if args.command == "doctor":
        print(json.dumps(doctor()))
    elif args.command == "beats":
        from analyzer.beats import analyze

        print(json.dumps(analyze(args.input)))


if __name__ == "__main__":
    main()
