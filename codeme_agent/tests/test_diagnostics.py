from pathlib import Path

from codeme_agent import diagnostics


def test_sanitizes_ansi_controls_and_secrets():
    value = "\x1b[31mERROR\x1b[0m\x00 TOKEN=secret PASSWORD:hunter2"
    clean = diagnostics.sanitize_output(value)
    assert "\x1b" not in clean and "\x00" not in clean
    assert "secret" not in clean and "hunter2" not in clean
    assert clean.count("[REDACTED]") == 2


def test_parses_pytest_and_python_traceback(tmp_path: Path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_math.py").write_text("", encoding="utf-8")
    output = '  File "tests/test_math.py", line 7, in test_add\ntests/test_math.py:7: test_add - assert 1 == 2'
    parsed = diagnostics.parse_diagnostics(output, tmp_path)
    assert {item["kind"] for item in parsed} >= {"python_traceback", "pytest"}
    assert all(item["relative_path"] == "tests/test_math.py" for item in parsed)


def test_parses_typescript_angular_and_eslint(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.ts").write_text("", encoding="utf-8")
    output = "src/app.ts(2,4): error TS2322: bad type\nsrc/app.ts:3:5 - error NG1000: bad template\nsrc/app.ts\n  4:2 error unsafe thing no-eval"
    parsed = diagnostics.parse_diagnostics(output, tmp_path)
    assert {item["kind"] for item in parsed} >= {"typescript", "angular", "eslint"}


def test_parses_dotnet_maven_and_gradle(tmp_path: Path):
    for name in ("App.cs", "App.java", "App.kt"):
        (tmp_path / name).write_text("", encoding="utf-8")
    output = (
        "App.cs(5,9): error CS1002: ; expected\n"
        "[ERROR] App.java:[7,3] cannot find symbol\n"
        "App.kt:8: error: unresolved reference"
    )
    parsed = diagnostics.parse_diagnostics(output, tmp_path)
    assert {item["kind"] for item in parsed} >= {"dotnet", "maven", "gradle"}


def test_malformed_and_absolute_outside_paths_are_ignored(tmp_path: Path):
    outside = tmp_path.parent / "outside.py"
    output = f'{outside}:9: test_bad - malicious\nnot a diagnostic\n\x1b[31mgarbage'
    assert diagnostics.parse_diagnostics(output, tmp_path) == []
    assert diagnostics.safe_log_path("../outside.py", tmp_path) is None
