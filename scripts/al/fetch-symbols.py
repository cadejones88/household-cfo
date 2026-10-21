#!/usr/bin/env python3
"""
Download the Business Central symbol packages an AL project needs from Microsoft's public NuGet feed (MSSymbols),
without a BC environment or container. Reads `application` and `platform` from app.json and fetches, for that major
version, the Platform (System.app) and the Microsoft apps the Application depends on into <project>/.alpackages.

Feed: https://dynamicssmb2.pkgs.visualstudio.com/DynamicsBCPublicFeeds/_packaging/MSSymbols/nuget/v3/index.json
Package ids follow '{publisher}.{name}.symbols.{appId}' (names without spaces); the platform is 'Microsoft.Platform.symbols'.
Used by .github/workflows/al-compile.yml. Prints what it found as GitHub annotations so a failed lookup is readable.
"""
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile

FEED = "https://dynamicssmb2.pkgs.visualstudio.com/DynamicsBCPublicFeeds/_packaging/MSSymbols/nuget/v3/index.json"
# The Microsoft apps an Application-level dependency pulls in. Country-specific variants are tried first for the
# base application (the household sandbox is US).
WANTED = [
    ("Microsoft.Platform.symbols", None),
    # The Application package id carries the country but no app id: Microsoft.Application.US.symbols.
    ("Microsoft.Application", ""),
    ("Microsoft.BaseApplication", "437dbf0e-84ff-417a-965d-ed2bb9650972"),
    ("Microsoft.SystemApplication", "63ca2fa4-4f03-4f2b-a480-172fef340d3f"),
    ("Microsoft.BusinessFoundation", "f3552374-a1f2-4356-848e-196002525837"),
]
COUNTRY = os.environ.get("BC_COUNTRY", "US")


def get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def get_bytes(url):
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def note(msg):
    print(f"::notice::{msg}", flush=True)


def main(project):
    app = json.load(open(os.path.join(project, "app.json"), encoding="utf-8-sig"))
    major = int(app["application"].split(".")[0])
    out = os.path.join(project, ".alpackages")
    os.makedirs(out, exist_ok=True)

    index = get_json(FEED)
    res = {r["@type"]: r["@id"] for r in index["resources"]}
    search = next(v for k, v in res.items() if k.startswith("SearchQueryService"))
    base = next(v for k, v in res.items() if k.startswith("PackageBaseAddress"))

    def versions(pkg_id):
        try:
            data = get_json(f"{base.rstrip('/')}/{pkg_id.lower()}/index.json")
            return data.get("versions", [])
        except Exception:
            return []

    def candidates(prefix, app_id):
        ids = []
        if app_id:
            ids += [f"{prefix}.{COUNTRY}.symbols.{app_id}", f"{prefix}.symbols.{app_id}"]
        elif app_id == "":
            ids += [f"{prefix}.{COUNTRY}.symbols", f"{prefix}.symbols"]
        else:
            ids += [prefix]
        # Search as a fallback, to learn the real ids if the guesses miss.
        try:
            q = urllib.parse.urlencode({"q": prefix, "take": 50, "prerelease": "false"})
            found = [d["id"] for d in get_json(f"{search}?{q}").get("data", [])]
            note(f"search '{prefix}': {', '.join(found[:12]) or 'nothing'}")
            # Fallback ids from search only when they are country-neutral or this country's (never another country's).
            ids += [i for i in found if i not in ids and "symbols" in i.lower() and (f".{COUNTRY}." in i or not re.search(r"\.[A-Z]{2}\.symbols", i))]
        except Exception as e:  # search is optional
            note(f"search '{prefix}' failed: {e}")
        return ids

    fetched = []
    for prefix, app_id in WANTED:
        got = False
        for pkg in candidates(prefix, app_id):
            vs = [v for v in versions(pkg) if re.match(rf"^{major}\.", v)]
            if not vs:
                continue
            v = sorted(vs, key=lambda s: [int(x) if x.isdigit() else 0 for x in re.split(r"[.-]", s)])[-1]
            nupkg = get_bytes(f"{base.rstrip('/')}/{pkg.lower()}/{v}/{pkg.lower()}.{v}.nupkg")
            with zipfile.ZipFile(io.BytesIO(nupkg)) as z:
                apps = [n for n in z.namelist() if n.lower().endswith(".app")]
                for n in apps:
                    target = os.path.join(out, os.path.basename(n))
                    with open(target, "wb") as f:
                        f.write(z.read(n))
                    fetched.append(f"{pkg} {v} -> {os.path.basename(n)}")
            got = bool(apps)
            if got:
                break
        if not got:
            print(f"::warning::No symbols found for {prefix} at version {major}.x", flush=True)

    for f in fetched:
        note(f"symbols: {f}")
    if not any("Platform" in f or "System.app" in f for f in fetched) or not any("Application" in f for f in fetched):
        print("::error::Could not fetch the platform and application symbols", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "bc/hh-app-connector")
