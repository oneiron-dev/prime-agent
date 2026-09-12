// This portable host protocol uses only Python's standard library. It never evaluates job shell text.
export const COMMAND_RUNNER_SOURCE = String.raw`
import datetime, hashlib, json, os, re, signal, stat, subprocess, sys, time

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def atomic(path, value):
    temp = path + ".tmp-" + str(os.getpid())
    with open(temp, "x", encoding="utf8") as f:
        json.dump(value, f, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    fd = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def load(path):
    with open(path, encoding="utf8") as f:
        return json.load(f)

def identity(pid):
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/" + str(pid) + "/stat") as f:
                fields = f.read().rsplit(")", 1)[1].split()
            if fields[0] == "Z":
                return None
            with open("/proc/sys/kernel/random/boot_id") as f:
                boot = f.read().strip()
            return boot + ":" + str(pid) + ":" + fields[19]
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="],
            check=True, text=True, capture_output=True)
        start = result.stdout.strip()
        return str(pid) + ":" + start if start else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None

def inspect(directory, manifest):
    try:
        existing = load(directory + "/manifest.json")
        if existing != manifest:
            return {"kind": "uncertain", "reason": "Attempt manifest identity mismatch"}
        terminal = directory + "/terminal.json"
        if os.path.exists(terminal):
            receipt = load(terminal)
            if receipt["attemptId"] != manifest["attemptId"] or receipt["sourceFingerprint"] != manifest["sourceFingerprint"]:
                return {"kind": "uncertain", "reason": "Terminal receipt identity mismatch"}
            return {"kind": "terminal", "receipt": receipt}
        started = load(directory + "/started.json")
        if started["attemptId"] != manifest["attemptId"] or started["sourceFingerprint"] != manifest["sourceFingerprint"]:
            return {"kind": "uncertain", "reason": "Launch receipt identity mismatch"}
        actual = identity(started["pid"])
        if actual is not None and actual == started["processIdentity"]:
            return {"kind": "running", "processIdentity": actual}
        return {"kind": "uncertain", "reason": "Supervisor identity absent or changed; child may still exist"}
    except (OSError, ValueError, KeyError, TypeError):
        return {"kind": "uncertain", "reason": "Attempt receipts absent or unreadable; execution may have started"}


def fingerprint(cwd):
    def git(args):
        return subprocess.run(["git", "-C", cwd] + args, check=True, capture_output=True).stdout
    digest = hashlib.sha256()
    def part(value):
        digest.update(str(len(value)).encode() + b":" + value)
    part(git(["rev-parse", "HEAD"]).strip())
    part(git(["rev-parse", "HEAD^{tree}"]).strip())
    part(git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]))
    for name in sorted(filter(None, git(["ls-files", "--others", "--exclude-standard", "-z"]).split(b"\0"))):
        path = os.path.join(os.fsencode(cwd), name)
        info = os.lstat(path)
        part(name)
        part(str(stat.S_IMODE(info.st_mode)).encode())
        if stat.S_ISLNK(info.st_mode):
            part(b"symlink")
            part(os.fsencode(os.readlink(path)))
        elif stat.S_ISREG(info.st_mode):
            part(b"file")
            with open(path, "rb") as f:
                part(f.read())
        else:
            raise ValueError("Unsupported untracked file type")
    return "git:" + digest.hexdigest()

def terminal(directory, manifest, code, artifact=None):
    receipt = {"attemptId": manifest["attemptId"], "sourceFingerprint": manifest["sourceFingerprint"],
        "exitCode": code, "finishedAt": now()}
    if artifact is not None:
        receipt["artifact"] = {"ref": manifest["command"]["cwd"], "sourceFingerprint": artifact}
    atomic(directory + "/terminal.json", receipt)

def supervise(directory, manifest):
    os.setsid()
    os.chdir(directory)
    null = os.open(os.devnull, os.O_RDONLY)
    log = os.open(directory + "/supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(null, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)
    if null > 2: os.close(null)
    if log > 2: os.close(log)
    pid = os.getpid()
    process_id = identity(pid)
    if process_id is None:
        # No child is launched without an inspectable supervisor identity.
        os._exit(1)
    atomic(directory + "/started.json", {"attemptId": manifest["attemptId"],
        "sourceFingerprint": manifest["sourceFingerprint"], "pid": pid,
        "processIdentity": process_id, "startedAt": now()})
    is_git = manifest["sourceFingerprint"].startswith("git:")
    if is_git:
        try:
            actual_source = fingerprint(manifest["command"]["cwd"])
        except Exception as error:
            print("Source verification failed: " + str(error), flush=True)
            terminal(directory, manifest, 125)
            os._exit(0)
        if actual_source != manifest["sourceFingerprint"]:
            print("Source fingerprint changed before launch", flush=True)
            terminal(directory, manifest, 125, actual_source)
            os._exit(0)
    try:
        with open(directory + "/stdout.log", "ab", buffering=0) as out, open(directory + "/stderr.log", "ab", buffering=0) as err:
            child_env = dict(os.environ)
            child_env.update(manifest["command"].get("env", {}))
            child_env.update(PRIME_FACTORY_ATTEMPT_ID=manifest["attemptId"],
                PRIME_FACTORY_SOURCE_FINGERPRINT=manifest["sourceFingerprint"])
            child = subprocess.Popen(manifest["command"]["argv"], cwd=manifest["command"]["cwd"], env=child_env,
                stdin=subprocess.DEVNULL, stdout=out, stderr=err, close_fds=True, start_new_session=True)
            atomic(directory + "/child.json", {"pid": child.pid, "processIdentity": identity(child.pid)})
            timeout = manifest["command"].get("timeoutMs")
            try:
                exit_code = child.wait(timeout=timeout / 1000 if timeout else None)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                exit_code = 124
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("Child process group still exists after leader exited; custody retained")
    except Exception as error:
        # Popen failed, or the supervisor failed after spawning. Only a proven spawn failure is terminal.
        if "child" in locals():
            print(str(error), flush=True)
            os._exit(1)
        exit_code = 127
        print(str(error), flush=True)
    terminal(directory, manifest, exit_code, fingerprint(manifest["command"]["cwd"]) if is_git else None)
    os._exit(0)

def main():
    request = json.load(sys.stdin)
    root = request["runnerRoot"]
    manifest = request["manifest"]
    attempt_id = manifest["attemptId"]
    if not os.path.isabs(root) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", attempt_id):
        raise ValueError("Invalid runner root or attempt identity")
    if not os.path.isabs(manifest["command"]["cwd"]) or not manifest["command"]["argv"]:
        raise ValueError("Command requires absolute cwd and nonempty argv")
    environment = manifest["command"].get("env", {})
    if not isinstance(environment, dict) or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
            or not isinstance(value, str) or "\0" in value for name, value in environment.items()):
        raise ValueError("Invalid command environment")
    if request["operation"] == "fingerprint":
        return {"sourceFingerprint": fingerprint(manifest["command"]["cwd"])}
    directory = os.path.join(root, attempt_id)
    if request["operation"] == "inspect":
        return inspect(directory, manifest)
    if request["operation"] != "launch":
        raise ValueError("Unknown operation")
    os.makedirs(root, mode=0o700, exist_ok=True)
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        return inspect(directory, manifest)
    atomic(directory + "/manifest.json", manifest)
    # The exclusive directory is never recycled, including an interrupted spawn.
    pid = os.fork()
    if pid == 0:
        try:
            supervise(directory, manifest)
        except BaseException:
            os._exit(1)
    for _ in range(50):
        result = inspect(directory, manifest)
        if result["kind"] != "uncertain":
            return result
        time.sleep(0.01)
    return inspect(directory, manifest)

try:
    print(json.dumps(main(), separators=(",", ":")), flush=True)
except Exception as error:
    print(json.dumps({"kind": "uncertain", "reason": "Host runner error: " + str(error)}), flush=True)
`;
