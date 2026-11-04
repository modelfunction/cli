import asyncio
import importlib.util
import json
import os
import sys
import time
import tracemalloc
import traceback
import inspect


def parse_args(argv):
    opts = {
        "entry": None,
        "input": None,
        "export": "run",
        "result": None,
        "warmup": 0,
        "allow_read": [],
        "allow_write": [],
        "allow_net": [],
    }
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in (
            "--entry",
            "--input",
            "--export",
            "--result",
            "--warmup",
            "--allow-read",
            "--allow-write",
            "--allow-net",
        ):
            if i + 1 >= len(argv):
                raise SystemExit("missing value for %s" % arg)
            value = argv[i + 1]
            i += 1
            if arg == "--entry":
                opts["entry"] = value
            elif arg == "--input":
                opts["input"] = value
            elif arg == "--export":
                opts["export"] = value
            elif arg == "--result":
                opts["result"] = value
            elif arg == "--warmup":
                opts["warmup"] = int(value or 0)
            elif arg == "--allow-read":
                opts["allow_read"].append(value)
            elif arg == "--allow-write":
                opts["allow_write"].append(value)
            elif arg == "--allow-net":
                opts["allow_net"].append(value)
        i += 1
    return opts


def peak_rss_mb():
    try:
        import resource

        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(value / (1048576.0 if sys.platform == "darwin" else 1024.0), 1)
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(ProcessMemoryCounters),
                wintypes.DWORD,
            ]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(ProcessMemoryCounters)
            psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
            return round(counters.PeakWorkingSetSize / 1048576.0, 1)
        except Exception:
            return None
    return None


def normalize(path):
    try:
        return os.path.normcase(os.path.realpath(os.path.abspath(path)))
    except Exception:
        return os.path.normcase(os.path.abspath(path))


def under(path, roots):
    for root in roots:
        if path == root or path.startswith(root + os.sep):
            return True
    return False


def host_allowed(host, allowed):
    if host is None:
        return False
    name = str(host).lower()
    for pattern in allowed:
        candidate = pattern.lower()
        if candidate.startswith("*."):
            candidate = candidate[2:]
            if name == candidate or name.endswith("." + candidate):
                return True
        elif name == candidate:
            return True
    return False


def install_audit_hook(allowed_read, allowed_write, allowed_net):
    def hook(event, args):
        if event == "open":
            path = args[0]
            mode = args[1] if len(args) > 1 else ""
            if isinstance(path, int):
                return
            resolved = normalize(str(path))
            writing = any(flag in (mode or "") for flag in "wax+")
            if writing:
                if not under(resolved, allowed_write):
                    raise PermissionError("mf-blocked: write %s" % resolved)
            elif not under(resolved, allowed_read):
                raise PermissionError("mf-blocked: read %s" % resolved)
        elif event == "socket.connect":
            address = args[1] if len(args) > 1 else None
            host = address[0] if isinstance(address, tuple) and address else None
            if not host_allowed(host, allowed_net):
                raise PermissionError("mf-blocked: connect %s" % host)
        elif event in ("socket.getaddrinfo", "socket.sendto", "socket.bind"):
            host = args[0] if args else None
            if isinstance(host, tuple):
                host = host[0] if host else None
            if not host_allowed(host, allowed_net):
                raise PermissionError("mf-blocked: net %s" % event)
        elif event in ("subprocess.Popen", "os.system", "os.exec", "os.fork", "os.forkpty", "os.spawn"):
            raise PermissionError("mf-blocked: %s" % event)
        elif event == "ctypes.dlopen":
            raise PermissionError("mf-blocked: ctypes.dlopen")

    sys.addaudithook(hook)


def emit(payload, result_path):
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if result_path:
        try:
            with open(result_path, "w", encoding="utf-8") as handle:
                handle.write(text)
            return
        except Exception:
            pass
    sys.stdout.write("__MF_RESULT__" + text + "\n")
    sys.stdout.flush()


def main():
    opts = parse_args(sys.argv[1:])
    entry = opts["entry"]
    input_path = opts["input"]
    result_path = opts["result"]

    if not entry or not input_path:
        emit({"ok": False, "error": {"name": "HarnessError", "message": "--entry and --input are required"}}, result_path)
        return 2

    start_rss = peak_rss_mb()
    harness_dir = os.path.dirname(os.path.abspath(__file__))
    entry_dir = os.path.dirname(os.path.abspath(entry))
    input_dir = os.path.dirname(os.path.abspath(input_path))
    cwd = os.getcwd()
    prefix_dirs = [normalize(value) for value in (sys.prefix, getattr(sys, "base_prefix", sys.prefix))]

    allowed_read = [normalize(value) for value in [harness_dir, entry_dir, input_dir, cwd] + opts["allow_read"]]
    allowed_read.extend(prefix_dirs)
    allowed_write = [
        normalize(value)
        for value in ([os.path.dirname(os.path.abspath(result_path))] if result_path else []) + opts["allow_write"]
    ]
    allowed_net = list(opts["allow_net"])

    with open(input_path, "r", encoding="utf-8") as handle:
        input_data = json.load(handle)

    install_audit_hook(allowed_read, allowed_write, allowed_net)

    if entry_dir not in sys.path:
        sys.path.insert(0, entry_dir)

    import_started = time.perf_counter()
    try:
        spec = importlib.util.spec_from_file_location("mf_tool_under_test", entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        function = (
            getattr(module, opts["export"], None)
            or getattr(module, "main", None)
            or getattr(module, "default", None)
        )
        if not callable(function):
            emit(
                {
                    "ok": False,
                    "error": {
                        "name": "HarnessError",
                        "message": "%s 需要导出 %s / main / default 函数" % (entry, opts["export"]),
                    },
                    "metrics": {"importMs": round((time.perf_counter() - import_started) * 1000, 2)},
                },
                result_path,
            )
            return 2
    except PermissionError as error:
        emit(
            {
                "ok": False,
                "permissionDenied": True,
                "error": {
                    "name": "PermissionError",
                    "code": "MF_PERMISSION_DENIED",
                    "message": str(error),
                    "phase": "import",
                },
                "metrics": {"importMs": round((time.perf_counter() - import_started) * 1000, 2)},
            },
            result_path,
        )
        return 3
    except Exception as error:
        emit(
            {
                "ok": False,
                "error": {
                    "name": type(error).__name__,
                    "message": str(error),
                    "traceback": traceback.format_exc(),
                    "phase": "import",
                },
                "metrics": {"importMs": round((time.perf_counter() - import_started) * 1000, 2)},
            },
            result_path,
        )
        return 1
    import_ms = (time.perf_counter() - import_started) * 1000

    warmup_error = None
    for _ in range(opts["warmup"]):
        try:
            outcome = function(input_data)
            if inspect.isawaitable(outcome):
                asyncio.run(outcome)
        except Exception as error:  # noqa: BLE001
            warmup_error = error
            break
    if warmup_error is not None:
        emit(
            {
                "ok": False,
                "error": {
                    "name": type(warmup_error).__name__,
                    "message": str(warmup_error),
                    "traceback": traceback.format_exc(),
                    "phase": "warmup",
                },
                "metrics": {"importMs": round(import_ms, 2)},
            },
            result_path,
        )
        return 1

    tracemalloc.start()
    cpu_started = time.process_time()
    call_started = time.perf_counter()
    try:
        outcome = function(input_data)
        if inspect.isawaitable(outcome):
            outcome = asyncio.run(outcome)
        duration_ms = (time.perf_counter() - call_started) * 1000
        cpu_ms = (time.process_time() - cpu_started) * 1000
        _, heap_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        emit(
            {
                "ok": True,
                "result": outcome,
                "metrics": {
                    "durationMs": round(duration_ms, 2),
                    "importMs": round(import_ms, 2),
                    "cpuMs": round(cpu_ms, 2),
                    "heapPeakMB": round(heap_peak / 1048576.0, 2),
                    "startRssMB": start_rss,
                    "peakRssMB": peak_rss_mb(),
                },
            },
            result_path,
        )
        return 0
    except PermissionError as error:
        duration_ms = (time.perf_counter() - call_started) * 1000
        cpu_ms = (time.process_time() - cpu_started) * 1000
        tracemalloc.stop()
        emit(
            {
                "ok": False,
                "permissionDenied": True,
                "error": {
                    "name": "PermissionError",
                    "code": "MF_PERMISSION_DENIED",
                    "message": str(error),
                    "phase": "call",
                },
                "metrics": {
                    "durationMs": round(duration_ms, 2),
                    "importMs": round(import_ms, 2),
                    "cpuMs": round(cpu_ms, 2),
                    "startRssMB": start_rss,
                    "peakRssMB": peak_rss_mb(),
                },
            },
            result_path,
        )
        return 3
    except Exception as error:
        duration_ms = (time.perf_counter() - call_started) * 1000
        cpu_ms = (time.process_time() - cpu_started) * 1000
        tracemalloc.stop()
        emit(
            {
                "ok": False,
                "error": {
                    "name": type(error).__name__,
                    "message": str(error),
                    "traceback": traceback.format_exc(),
                    "phase": "call",
                },
                "metrics": {
                    "durationMs": round(duration_ms, 2),
                    "importMs": round(import_ms, 2),
                    "cpuMs": round(cpu_ms, 2),
                    "startRssMB": start_rss,
                    "peakRssMB": peak_rss_mb(),
                },
            },
            result_path,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
