import json
import platform
import subprocess
import sys


def test_doctor_prints_one_json_line_with_python_version():
    result = subprocess.run(
        [sys.executable, "-m", "analyzer", "doctor"], capture_output=True, text=True, check=True
    )
    lines = result.stdout.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {"ok": True, "python": platform.python_version()}
