import { spawnSync } from "node:child_process";
import { permissionFlag } from "./node-permission.js";

// Shared CI runners can be slow to start a process; a 4s probe that times out
// under load turns into a false "engine unavailable" and flakes the suite.
function run(command, args, timeout = 10_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error?.code ?? null,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}

function versionOf(result) {
  const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0];
  return line || null;
}

export function checkSandbox() {
  const platform = process.platform;
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const permission = run(process.execPath, [permissionFlag(), "-e", "0"]);

  const pythonProbe = platform === "win32" ? run("python", ["--version"]) : run("python3", ["--version"]);
  const pythonFallback = pythonProbe.ok ? pythonProbe : run("python", ["--version"]);
  const pythonOk = pythonProbe.ok || pythonFallback.ok;

  const bwrapVersion = platform === "linux" ? run("bwrap", ["--version"]) : { ok: false };
  const bwrapFunctional =
    bwrapVersion.ok &&
    run("bwrap", ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "/bin/true"]).ok;

  const seatbelt =
    platform === "darwin"
      ? run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/echo", "ok"])
      : { ok: false };

  const docker = run("docker", ["version", "--format", "{{.Server.Version}}"]);

  let wslInfo = { ok: false, distro: null, bwrap: false };
  if (platform === "win32") {
    const wslList = run("wsl", ["-l", "-q"]);
    if (wslList.ok) {
      const distroProbe = run("wsl", ["-e", "sh", "-c", "echo $WSL_DISTRO_NAME"]);
      const bwrapProbe = run("wsl", [
        "-e",
        "sh",
        "-c",
        "command -v bwrap >/dev/null && bwrap --unshare-user --unshare-net --ro-bind / / /bin/true && echo ok"
      ]);
      wslInfo = {
        ok: true,
        distro: distroProbe.stdout.trim() || null,
        bwrap: /(^|\n)ok(\n|$)/.test(bwrapProbe.stdout)
      };
    }
  }

  const engines = [
    {
      name: "node-permission",
      available: permission.ok,
      version: `node ${nodeVersion}`,
      canBlock: { fs: true, net: nodeMajor >= 25, child: true },
      note:
        nodeMajor >= 25
          ? "仅 Node 工具；能力限制，不是安全边界"
          : "仅 Node 工具；网络控制需 Node >= 25，当前版本不限制网络"
    },
    {
      name: "python-audit",
      available: pythonOk,
      version: versionOf(pythonFallback) ?? null,
      canBlock: { fs: true, net: true, child: true },
      note: "audit hook 能力限制，可被 ctypes 等方式绕过；不是安全边界"
    },
    {
      name: "bwrap",
      available: Boolean(bwrapFunctional),
      version: versionOf(bwrapVersion) ?? null,
      canBlock: { fs: true, net: true, child: true },
      note:
        bwrapVersion.ok && !bwrapFunctional
          ? "已安装但不可用（非特权 userns 可能被 AppArmor 限制）"
          : "Linux 命名空间隔离"
    },
    {
      name: "sandbox-exec",
      available: Boolean(seatbelt.ok),
      version: seatbelt.ok ? "system" : null,
      canBlock: { fs: true, net: true, child: true },
      note: "macOS 自带；Apple 已标记废弃"
    },
    {
      name: "docker",
      available: Boolean(docker.ok),
      version: docker.stdout || null,
      canBlock: { fs: true, net: true, child: true },
      note: docker.ok ? "容器隔离；需要镜像与守护进程" : "未安装或守护进程未运行"
    },
    {
      name: "wsl2",
      available: wslInfo.ok,
      version: wslInfo.distro,
      canBlock: { fs: false, net: false, child: false },
      note: wslInfo.ok ? "WSL2 已启用；本身不是隔离引擎" : "未启用"
    },
    {
      name: "wsl2-bwrap",
      available: wslInfo.ok && wslInfo.bwrap,
      version: wslInfo.distro,
      canBlock: { fs: true, net: true, child: true },
      note:
        wslInfo.ok && !wslInfo.bwrap
          ? "WSL2 内没有可用的 bwrap：需要安装 Linux 发行版并在其中 apt install bubblewrap"
          : "通过 WSL2 内的 bwrap 提供强隔离"
    }
  ];

  const nodeEngine = engines.find((engine) => engine.name === "node-permission" && engine.available);
  const pythonEngine = engines.find((engine) => engine.name === "python-audit" && engine.available);
  const strongEngine = engines.find(
    (engine) => ["bwrap", "sandbox-exec", "docker", "wsl2-bwrap"].includes(engine.name) && engine.available
  );

  return {
    platform,
    node: { version: nodeVersion, permission: permission.ok, networkControl: nodeMajor >= 25 },
    engines,
    recommendation: {
      nodeTools: nodeEngine ? nodeEngine.name : null,
      pythonTools: pythonEngine ? pythonEngine.name : null,
      strongIsolation: strongEngine ? strongEngine.name : null,
      note: strongEngine
        ? "强隔离引擎可用；能力限制模型（node-permission / python-audit）仍不是安全边界"
        : "默认用能力限制模式即可（无需安装）；只有当你要执行不可信代码时才需要强隔离——优先选远程沙箱（零本地安装），其次 WSL2/Docker"
    }
  };
}

export function formatSandboxReport(report) {
  const lines = [`sandbox check（${report.platform}，node ${report.node.version}）`, "", "engines:"];
  for (const engine of report.engines) {
    if (!engine.available) {
      lines.push(`  ${engine.name.padEnd(16)} n/a`);
      continue;
    }
    const caps = [
      engine.canBlock.fs ? "fs" : null,
      engine.canBlock.net ? "net" : null,
      engine.canBlock.child ? "child" : null
    ]
      .filter(Boolean)
      .join("/");
    lines.push(`  ${engine.name.padEnd(16)} ok  ${caps}  ${engine.version ?? ""}`);
    if (engine.note) lines.push(`  ${" ".repeat(18)}${engine.note}`);
  }

  lines.push("", "recommendation:");
  lines.push(`  Node 工具:   ${report.recommendation.nodeTools ?? "不可用"}`);
  lines.push(`  Python 工具: ${report.recommendation.pythonTools ?? "不可用"}`);
  lines.push(`  强隔离:      ${report.recommendation.strongIsolation ?? "不可用"}`);
  lines.push(`  ${report.recommendation.note}`);
  return lines.join("\n");
}
