"""Search the AL source inside Microsoft's symbol packages (no BC environment needed).

Used to find which tables base-app code reads, and which of those its objects cover with their own Permissions
property, before a permission change goes to the sandbox. Writes the matches to an output file.

usage: trace-source.py <packages dir> <path regex> <line regex or '*'> <out file>
"""
import io
import os
import re
import sys
import zipfile

pkgs, path_re, line_re, out_path = sys.argv[1:5]
path_pat = re.compile(path_re, re.I)
whole = line_re == "*"
line_pat = None if whole else re.compile(line_re)
out = []
total_al = 0
for name in sorted(os.listdir(pkgs)):
    if not name.endswith(".app"):
        continue
    data = open(os.path.join(pkgs, name), "rb").read()
    start = data.find(b"PK\x03\x04")
    if start < 0:
        out.append(f"# {name}: no zip payload")
        continue
    try:
        z = zipfile.ZipFile(io.BytesIO(data[start:]))
    except zipfile.BadZipFile as e:
        out.append(f"# {name}: {e}")
        continue
    als = [n for n in z.namelist() if n.lower().endswith(".al")]
    total_al += len(als)
    out.append(f"# {name}: {len(als)} .al files")
    for n in als:
        if not path_pat.search(n):
            continue
        text = z.read(n).decode("utf-8-sig", errors="replace").splitlines()
        out.append(f"## {n}")
        for i, line in enumerate(text, 1):
            if whole or line_pat.search(line):
                out.append(f"{i}: {line}")
open(out_path, "w", encoding="utf-8").write("\n".join(out[:20000]) + "\n")
print(f"::notice::{total_al} .al files in the packages; {len(out)} output lines written")
