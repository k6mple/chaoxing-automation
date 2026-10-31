"""Build a source-only skill ZIP; never sweep the workspace or user runtime data."""
from pathlib import Path
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOP_FILES = ["README.md", "LICENSE", "SKILL.md", "WORK_PLAN.md", "package.json", "package-lock.json", "engine-manifest.json", ".gitignore", ".gitattributes"]
DIRECTORIES = ["agents", "references", "scripts", "test"]
FORBIDDEN = {"node_modules", ".chaoxing", "data", "chrome-profile", "__pycache__", ".git", "dist"}


def source_files():
    files = [ROOT / name for name in TOP_FILES]
    for directory in DIRECTORIES:
        for file in (ROOT / directory).rglob("*"):
            if any(part in FORBIDDEN for part in file.relative_to(ROOT).parts):
                continue
            if file.is_symlink():
                raise ValueError(f"Refusing symlink: {file.relative_to(ROOT)}")
            if file.is_file():
                files.append(file)
    for file in files:
        if not file.is_file() or file.is_symlink():
            raise ValueError(f"Missing or invalid source: {file.name}")
        if file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"Unexpectedly large source: {file.name}")
        text = file.read_text(encoding="utf-8")
        if re.search(r"(?:DEEPSEEK_API_KEY|CX_VISION_API_KEY)\s*[:=]\s*['\"]sk-[A-Za-z0-9]{12,}", text):
            raise ValueError(f"Potential embedded credential: {file.name}")
    return sorted(set(files))


def main():
    files = source_files()
    directory = ROOT / "dist"
    directory.mkdir(exist_ok=True)
    output = directory / "chaoxing-automation.zip"
    temporary = directory / "chaoxing-automation.zip.tmp"
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for file in files:
                archive.write(file, "chaoxing-automation/" + file.relative_to(ROOT).as_posix())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"archive": str(output), "files": len(files), "bytes": output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
