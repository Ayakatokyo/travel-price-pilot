"""Project-owned browser session for OpenCLI's supported direct CDP backend."""

import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
SESSION = ROOT / "local" / "browser"
PROFILE = SESSION / "profile"


def browser_binary():
    explicit = os.environ.get("TRAVEL_CHROME_PATH")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise RuntimeError("TRAVEL_CHROME_PATH does not name a browser executable")
        return path
    candidates = list((Path.home() / ".cache/puppeteer/chrome").glob(
        "*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"))
    candidates.sort(key=lambda p: tuple(map(int, re.findall(r"\d+", str(p)))), reverse=True)
    candidates += [Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    for path in candidates:
        if path.is_file():
            return path
    raise RuntimeError("Chrome is unavailable; set TRAVEL_CHROME_PATH")


def existing_endpoint():
    port_file = PROFILE / "DevToolsActivePort"
    try:
        port = int(port_file.read_text().splitlines()[0])
        if not 1024 <= port <= 65535:
            return None
        endpoint = f"http://127.0.0.1:{port}"
        with urlopen(endpoint + "/json/version", timeout=1) as response:
            version = json.load(response)
        return endpoint if version.get("Browser") else None
    except (OSError, ValueError, IndexError):
        return None


def start_browser():
    endpoint = existing_endpoint()
    if endpoint:
        return endpoint
    SESSION.mkdir(parents=True, exist_ok=True, mode=0o700)
    SESSION.chmod(0o700)
    PROFILE.mkdir(exist_ok=True, mode=0o700)
    command = [str(browser_binary()), f"--user-data-dir={PROFILE}",
               "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
               "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"]
    with (SESSION / "browser.log").open("ab") as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   start_new_session=True)
    (SESSION / "pid").write_text(str(process.pid))
    for _ in range(40):
        endpoint = existing_endpoint()
        if endpoint:
            return endpoint
        if process.poll() is not None:
            raise RuntimeError("Project browser exited before its CDP endpoint became ready")
        time.sleep(0.25)
    raise RuntimeError("Project browser startup timed out")


def stop_browser():
    try:
        pid = int((SESSION / "pid").read_text())
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                 capture_output=True, text=True, check=False).stdout
        if f"--user-data-dir={PROFILE}" in command:
            os.kill(pid, signal.SIGTERM)
            return True
    except (OSError, ValueError):
        pass
    return False


def target_endpoint(provider):
    """Keep each provider on its own tab, preserving any pending login page."""
    endpoint = start_browser()
    with urlopen(endpoint + "/json", timeout=3) as response:
        targets = json.load(response)
    mapping_file = SESSION / "targets.json"
    mapping = json.loads(mapping_file.read_text()) if mapping_file.exists() else {}
    for target in targets:
        if target.get("id") == mapping.get(provider):
            return target["webSocketDebuggerUrl"]
    if provider in ("ctrip", "booking"):
        for target in targets:
            from urllib.parse import urlparse
            hostname = urlparse(target.get("url", "")).hostname or ""
            matches = (hostname == "passport.ctrip.com" if provider == "ctrip" else
                       hostname in ("www.booking.com", "account.booking.com"))
            if matches:
                mapping[provider] = target["id"]
                mapping_file.write_text(json.dumps(mapping))
                return target["webSocketDebuggerUrl"]
    if os.environ.get("TRAVEL_BACKGROUND") == "1":
        # Creating a tab through /json/new activates it. CDP's background option
        # lets collection continue without interrupting a pending manual login.
        script = """import {CDPBridge} from '@jackwener/opencli/browser/cdp';
const b=new CDPBridge();
try {await b.connect();console.log(JSON.stringify(await b.send('Target.createTarget',{url:'about:blank',background:true})));}
finally {await b.close();}"""
        env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCLI_")}
        env["OPENCLI_CDP_ENDPOINT"] = endpoint
        created = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, env=env,
                                 capture_output=True, text=True, timeout=15, check=True)
        target_id = json.loads(created.stdout)["targetId"]
        with urlopen(endpoint + "/json", timeout=3) as response:
            target = next(t for t in json.load(response) if t["id"] == target_id)
    else:
        with urlopen(Request(endpoint + "/json/new?about:blank", method="PUT"), timeout=3) as response:
            target = json.load(response)
    mapping[provider] = target["id"]
    mapping_file.write_text(json.dumps(mapping))
    return target["webSocketDebuggerUrl"]


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "stop"], nargs="?", default="start")
    args = parser.parse_args()
    if args.action == "stop":
        print(json.dumps({"stopped": stop_browser()}))
    else:
        print(json.dumps({"endpoint": start_browser(), "profile": str(PROFILE)}))
