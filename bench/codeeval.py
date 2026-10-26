#!/usr/bin/env python3
"""Sandboxed grading of python solutions: hidden tests, 10 s timeout, network denied (sandbox-exec on macOS plus a socket stub)."""
import os, re, shutil, subprocess, sys, tempfile

STUB = ("import socket as _s\n"
        "def _deny(*a, **k): raise OSError('network disabled')\n"
        "_s.socket = _deny; _s.create_connection = _deny; _s.getaddrinfo = _deny\n")

def extract(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    blocks = re.findall(r"```(?:python|py)?[ \t]*\n(.*?)```", text, re.S)
    if blocks:
        return max(blocks, key=len) if len(blocks) > 1 and not any("def " in b or "class " in b for b in blocks[-1:]) else blocks[-1]
    return text if ("def " in text or "class " in text) else ""


def run_tests(code, tests, timeout=10):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "t.py")
        open(p, "w").write(STUB + code + "\n\n" + tests + "\n")
        cmd = [sys.executable, "-I", p]
        if shutil.which("sandbox-exec"):
            cmd = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"] + cmd
        try:
            r = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return False, "timeout"
        return r.returncode == 0, (r.stderr or "").strip().splitlines()[-1:] and r.stderr.strip().splitlines()[-1] or ""

