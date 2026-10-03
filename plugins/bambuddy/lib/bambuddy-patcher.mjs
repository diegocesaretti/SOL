import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRINTERS_RELATIVE = join("app", "backend", "app", "api", "routes", "printers.py");
const MODEL_MARKER = 'if path == "/model" and not listing.available:';
const PRINT_MARKER = '@router.post("/{printer_id}/print-sd")';

const MODEL_ORIGINAL = `    listing = await list_files_result_async(
        printer.ip_address,
        printer.access_code,
        path,
        printer_model=printer.model,
    )
    files = listing.files

    # Add full path to each file
    for f in files:
        f["path"] = f"{path.rstrip('/')}/{f['name']}" if path != "/" else f"/{f['name']}"

    return {
        "path": path,
        "files": files,
        "warnings": [] if listing.available else ["printer_unavailable"],
    }
`;

const MODEL_PATCHED = `    listing = await list_files_result_async(
        printer.ip_address,
        printer.access_code,
        path,
        printer_model=printer.model,
    )
    effective_path = path
    if path == "/model" and not listing.available:
        root_listing = await list_files_result_async(
            printer.ip_address,
            printer.access_code,
            "/",
            printer_model=printer.model,
        )
        if root_listing.available:
            listing = root_listing
            effective_path = "/"

    files = listing.files

    # Add full path to each file
    for f in files:
        f["path"] = (
            f"{effective_path.rstrip('/')}/{f['name']}"
            if effective_path != "/"
            else f"/{f['name']}"
        )

    return {
        "path": effective_path,
        "files": files,
        "warnings": [] if listing.available else ["printer_unavailable"],
    }
`;

const PRINT_ANCHOR = `# =============================================================================
# Print Control Endpoints
# =============================================================================


@router.post("/{printer_id}/print/stop")
`;

const PRINT_PATCH = `# =============================================================================
# Print Control Endpoints
# =============================================================================


@router.post("/{printer_id}/print-sd")
async def print_sd_file(
    printer_id: int,
    filename: str = Query(..., min_length=1, max_length=255, description="3MF filename already stored in the printer SD root"),
    plate_id: int = Query(1, ge=1, le=99, description="Plate number inside the 3MF"),
    ams_mapping: list[int] | None = Query(None, description="Optional tray IDs; external spool is 254"),
    bed_levelling: str = Query("auto", pattern="^(off|on|auto)$"),
    flow_cali: str = Query("auto", pattern="^(off|on|auto)$"),
    vibration_cali: bool = Query(True),
    layer_inspect: bool = Query(False),
    timelapse: bool = Query(False),
    use_ams: bool = Query(False),
    _=RequirePermissionIfAuthEnabled(Permission.PRINTERS_CONTROL),
    db: AsyncSession = Depends(get_db),
):
    """Start a 3MF that already exists in the printer SD root.

    No upload is performed. The route validates the filename against the
    printer's FTPS root listing, then delegates to Bambuddy's existing
    printer_manager.start_print() project_file dispatch.
    """
    result = await db.execute(select(Printer).where(Printer.id == printer_id))
    printer = result.scalar_one_or_none()
    if not printer:
        raise HTTPException(404, "Printer not found")

    client = printer_manager.get_client(printer_id)
    if not client:
        raise HTTPException(400, "Printer not connected")

    name = filename.strip().lstrip("/")
    if (
        not name
        or "/" in name
        or "\\\\" in name
        or name.startswith(".")
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in name)
    ):
        raise HTTPException(400, "Only a root-level SD filename is allowed")
    if not name.lower().endswith(".3mf"):
        raise HTTPException(400, "Direct SD printing currently supports 3MF files only")

    listing = await list_files_result_async(
        printer.ip_address,
        printer.access_code,
        "/",
        printer_model=printer.model,
    )
    if not listing.available:
        raise HTTPException(503, "Printer SD file service is unavailable")

    match = next(
        (
            item
            for item in listing.files
            if item.get("name") == name and not item.get("is_directory", False)
        ),
        None,
    )
    if match is None:
        raise HTTPException(404, "File not found in printer SD root")

    state = printer_manager.get_status(printer_id)
    if state and state.state in {"PREPARE", "SLICING", "RUNNING", "PAUSE"}:
        raise HTTPException(409, f"Printer is busy (state={state.state})")

    success = printer_manager.start_print(
        printer_id,
        name,
        plate_id=plate_id,
        ams_mapping=ams_mapping,
        bed_levelling=bed_levelling,
        flow_cali=flow_cali,
        vibration_cali=vibration_cali,
        layer_inspect=layer_inspect,
        timelapse=timelapse,
        use_ams=use_ams,
    )
    if not success:
        raise HTTPException(502, "Bambuddy could not dispatch the SD print")

    return {
        "success": True,
        "message": "SD print command sent",
        "printer_id": printer_id,
        "filename": name,
        "plate_id": plate_id,
        "use_ams": use_ams,
        "ams_mapping": ams_mapping,
    }


@router.post("/{printer_id}/print/stop")
`;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function normalizeLf(text) {
  return String(text).replace(/\r\n/g, "\n");
}
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function targetPath(installDir) {
  return join(installDir, PRINTERS_RELATIVE);
}

export async function inspectBambuddyPatches(installDir, dataDir) {
  const file = targetPath(installDir);
  const present = await exists(file);
  const statePath = join(dataDir, "patch-state.json");
  let lastRun = null;
  try {
    lastRun = JSON.parse(await readFile(statePath, "utf8"));
  } catch {}
  if (!present) {
    return {
      ok: false,
      installDir,
      target: file,
      exists: false,
      modelFilesFallback: false,
      directSdPrint: false,
      complete: false,
      compatible: false,
      issues: ["printers.py_not_found"],
      lastRun
    };
  }

  const raw = await readFile(file, "utf8");
  const source = normalizeLf(raw);
  const modelFilesFallback = source.includes(MODEL_MARKER);
  const directSdPrint = source.includes(PRINT_MARKER);
  const issues = [];
  if (!modelFilesFallback && !source.includes(MODEL_ORIGINAL)) issues.push("model_files_anchor_not_found");
  if (!directSdPrint && !source.includes(PRINT_ANCHOR)) issues.push("print_sd_anchor_not_found");

  return {
    ok: true,
    installDir,
    target: file,
    exists: true,
    sha256: sha256(raw),
    modelFilesFallback,
    directSdPrint,
    complete: modelFilesFallback && directSdPrint,
    compatible: issues.length === 0,
    issues,
    lastRun
  };
}

export async function prepareBambuddyPatch(installDir, dataDir) {
  await mkdir(dataDir, { recursive: true });
  const status = await inspectBambuddyPatches(installDir, dataDir);
  if (!status.exists) throw new Error("bambuddy_printers_py_not_found");
  if (status.complete) return { ...status, action: "already_patched" };
  if (!status.compatible) {
    const error = new Error(`bambuddy_patch_incompatible:${status.issues.join(",")}`);
    error.patchStatus = status;
    throw error;
  }

  const raw = await readFile(status.target, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let source = normalizeLf(raw);
  const applied = [];
  if (!source.includes(MODEL_MARKER)) {
    source = source.replace(MODEL_ORIGINAL, MODEL_PATCHED);
    applied.push("model-files-fallback");
  }
  if (!source.includes(PRINT_MARKER)) {
    source = source.replace(PRINT_ANCHOR, PRINT_PATCH);
    applied.push("direct-sd-print");
  }

  const patched = eol === "\r\n" ? source.replace(/\n/g, "\r\n") : source;
  const workDir = join(dataDir, "patch-work");
  const backupDir = join(dataDir, "patch-backups");
  await mkdir(workDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const staged = join(workDir, `printers.py.${stamp}.patched`);
  const script = join(workDir, `apply-bambuddy-patch-${stamp}.ps1`);
  const resultPath = join(dataDir, "patch-state.json");
  const backup = join(backupDir, `printers.py.${stamp}.${status.sha256.slice(0, 12)}.bak`);
  await writeFile(staged, patched, "utf8");

  const expectedHash = sha256(patched);
  const ps = `$ErrorActionPreference = "Stop"
$target = ${quotePowerShell(status.target)}
$staged = ${quotePowerShell(staged)}
$backup = ${quotePowerShell(backup)}
$result = ${quotePowerShell(resultPath)}
$expected = ${quotePowerShell(expectedHash)}
$serviceName = "Bambuddy"
$started = (Get-Date).ToString("o")
try {
  if (-not (Test-Path -LiteralPath $target)) { throw "Target printers.py not found" }
  Copy-Item -LiteralPath $target -Destination $backup -Force
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $staged -Destination $target -Force
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Patched file SHA256 mismatch" }
  Start-Service -Name $serviceName
  $svc = Get-Service -Name $serviceName
  $svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
  @{ ok = $true; status = "patched"; at = (Get-Date).ToString("o"); startedAt = $started; backup = $backup; sha256 = $actual } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding UTF8
  exit 0
}
catch {
  $message = $_.Exception.Message
  try {
    if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $target -Force }
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
  } catch {}
  @{ ok = $false; status = "failed"; at = (Get-Date).ToString("o"); startedAt = $started; backup = $backup; error = $message } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding UTF8
  exit 1
}
`;
  await writeFile(script, ps, "utf8");

  return {
    ...status,
    action: "prepared",
    applied,
    staged,
    script,
    backup,
    expectedSha256: expectedHash,
    resultPath
  };
}

export async function launchBambuddyPatch(installDir, dataDir, { force = false } = {}) {
  const prepared = await prepareBambuddyPatch(installDir, dataDir);
  if (prepared.action === "already_patched") return { ...prepared, launched: false };

  if (!force && prepared.lastRun?.launchedAt) {
    const age = Date.now() - Date.parse(prepared.lastRun.launchedAt);
    if (Number.isFinite(age) && age < 60 * 60 * 1000 && prepared.lastRun.status === "launched") {
      return { ...prepared, launched: false, suppressed: "recent_uac_launch" };
    }
  }

  const launchState = {
    ok: null,
    status: "launched",
    launchedAt: new Date().toISOString(),
    script: prepared.script,
    expectedSha256: prepared.expectedSha256
  };
  await writeFile(prepared.resultPath, JSON.stringify(launchState, null, 2), "utf8");

  const command = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${quotePowerShell(prepared.script)}) -Verb RunAs -PassThru; exit 0`;
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    windowsHide: true,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return { ...prepared, launched: true, uacRequired: true };
}