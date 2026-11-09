#!/usr/bin/env python3
"""Read-only network diagnostics. No DNS, proxy, registry or TLS changes."""
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import urllib.parse
import urllib.request


def read(path):
    try:
        return Path(path).read_text()
    except OSError as error:
        return str(error)


report = {"resolver": read("/etc/resolv.conf"), "wsl": read("/etc/wsl.conf")}
report["network_devices"] = read("/proc/net/dev")
report["routes"] = read("/proc/net/route")
report["process_restrictions"] = [
    line for line in read("/proc/self/status").splitlines()
    if line.startswith(("Seccomp", "NoNewPrivs", "CapEff"))
]
# Do not print proxy passwords, URLs, credentials, registry tokens or NO_PROXY values.
report["proxy_variable_names"] = sorted(
    key for key in os.environ if key.lower().endswith("proxy")
)
report["cargo_variable_names"] = sorted(
    key for key in os.environ if key.startswith("CARGO_")
)
report["tls_default_paths"] = ssl.get_default_verify_paths()._asdict()
report["socket_creation"] = {}
blocked = False
for family in (socket.AF_INET, socket.AF_INET6):
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        name = f"{family.name}/{kind.name}"
        try:
            with socket.socket(family, kind):
                report["socket_creation"][name] = "OK"
        except OSError as error:
            report["socket_creation"][name] = f"{type(error).__name__}: {error}"
            blocked |= isinstance(error, PermissionError)

report["dns"] = {}
for host in ("index.crates.io", "static.crates.io", "github.com"):
    try:
        report["dns"][host] = sorted({
            result[4][0] for result in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        })
    except OSError as error:
        report["dns"][host] = f"{type(error).__name__}: {error}"

report["https"] = {}
if blocked:
    report["https"] = "Not attempted: Internet socket creation denied by process policy."
else:
    for url in (
        "https://index.crates.io/config.json",
        "https://static.crates.io/crates/bumpalo/bumpalo-3.20.3.crate",
    ):
        try:
            request = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(request, timeout=8, context=ssl.create_default_context()) as response:
                report["https"][url] = response.status
        except Exception as error:
            # Exception text may contain authenticated proxy URLs. Print type only.
            report["https"][url] = type(error).__name__

print(json.dumps(report, indent=2))
if blocked:
    sys.exit(2)
if any(not isinstance(value, list) for value in report["dns"].values()):
    sys.exit(1)
if any(value != 200 for value in report["https"].values()):
    sys.exit(1)
