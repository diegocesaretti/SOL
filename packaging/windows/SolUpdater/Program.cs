using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

namespace SolUpdater;

internal static class Program
{
    private sealed record UpdateRequest(
        int SchemaVersion,
        string Version,
        string Commit,
        string DownloadUrl,
        string Sha256,
        string PublishedAt,
        string RequestedAt,
        int Port);

    private static string? _logPath;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        var options = ParseArgs(args);
        if (!options.TryGetValue("root", out var root) ||
            !options.TryGetValue("data", out var dataRoot) ||
            !options.TryGetValue("request", out var requestPath) ||
            !options.TryGetValue("launcher-pid", out var launcherPidText) ||
            !int.TryParse(launcherPidText, out var launcherPid))
        {
            MessageBox(IntPtr.Zero, "La solicitud de actualización de SOL está incompleta.", "SOL Updater", 0x10);
            return 2;
        }

        root = Path.GetFullPath(root);
        dataRoot = Path.GetFullPath(dataRoot);
        requestPath = Path.GetFullPath(requestPath);
        Directory.CreateDirectory(Path.Combine(dataRoot, "logs"));
        _logPath = Path.Combine(dataRoot, "logs", "updater.log");

        try
        {
            Log($"Updater starting. root={root}");
            var request = await ReadRequest(requestPath);
            ValidateRequest(request);

            var updatesDir = Path.Combine(dataRoot, "updates");
            Directory.CreateDirectory(updatesDir);
            var zipPath = Path.Combine(updatesDir, $"SOL-Windows-{SafeName(request.Version)}.zip");
            await DownloadPackage(request.DownloadUrl, zipPath);
            VerifySha256(zipPath, request.Sha256);
            Log($"Package verified: {request.Version} {request.Commit}");

            var operationId = $"{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Environment.ProcessId}";
            var stagingRoot = root + $".update-staging-{operationId}";
            var backupRoot = root + $".update-backup-{operationId}";
            CleanupStaleUpdateDirectories(root, stagingRoot, backupRoot);
            Directory.CreateDirectory(stagingRoot);
            ZipFile.ExtractToDirectory(zipPath, stagingRoot, overwriteFiles: true);
            var packageRoot = ResolveExtractedPackageRoot(stagingRoot);
            ValidateExtractedPackage(packageRoot, request);

            await WaitForProcessExit(launcherPid, TimeSpan.FromSeconds(30));
            await StopProcessesUsingInstallFamily(root, TimeSpan.FromSeconds(20));

            Process? newLauncher = null;
            var swapped = false;
            try
            {
                await MoveDirectoryWithRetry(root, backupRoot, TimeSpan.FromSeconds(30));
                swapped = true;
                await MoveDirectoryWithRetry(packageRoot, root, TimeSpan.FromSeconds(30));
                if (File.Exists(requestPath)) File.Delete(requestPath);

                newLauncher = StartLauncher(root);
                var healthy = await WaitForHealth(request.Port, TimeSpan.FromSeconds(45));
                if (!healthy) throw new InvalidOperationException("La nueva versión no respondió en /health.");

                Log($"Update completed successfully: {request.Version} {request.Commit}");
                await DeleteDirectoryWithRetry(backupRoot, TimeSpan.FromSeconds(15), throwOnTimeout: false);
                await DeleteDirectoryWithRetry(stagingRoot, TimeSpan.FromSeconds(10), throwOnTimeout: false);
                TryDelete(zipPath);
                return 0;
            }
            catch (Exception updateError)
            {
                Log($"New build failed: {updateError}");
                if (newLauncher is not null)
                {
                    try
                    {
                        if (!newLauncher.HasExited)
                        {
                            newLauncher.Kill(entireProcessTree: true);
                            await newLauncher.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                        }
                    }
                    catch (Exception killError) { Log($"Could not stop failed launcher: {killError}"); }
                }

                if (swapped && Directory.Exists(backupRoot))
                {
                    await StopProcessesUsingInstallFamily(root, TimeSpan.FromSeconds(15));
                    await DeleteDirectoryWithRetry(root, TimeSpan.FromSeconds(20), throwOnTimeout: true);
                    await MoveDirectoryWithRetry(backupRoot, root, TimeSpan.FromSeconds(30));
                    if (File.Exists(requestPath)) File.Delete(requestPath);
                    StartLauncher(root);
                    Log("Rollback completed and previous SOL build restarted.");
                    MessageBox(IntPtr.Zero,
                        $"La actualización a SOL {request.Version} falló y SOL restauró automáticamente la versión anterior.\n\nDetalle: {updateError.Message}\n\nLog: {_logPath}",
                        "SOL · actualización revertida", 0x30);
                    return 3;
                }

                throw;
            }
        }
        catch (Exception ex)
        {
            Log($"Updater failed: {ex}");
            MessageBox(IntPtr.Zero,
                $"No se pudo actualizar SOL. La instalación actual no fue reemplazada.\n\n{ex.Message}\n\nLog: {_logPath}",
                "SOL Updater", 0x10);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index + 1 < args.Length; index += 2)
        {
            var key = args[index];
            if (!key.StartsWith("--", StringComparison.Ordinal)) continue;
            values[key[2..]] = args[index + 1];
        }
        return values;
    }

    private static async Task<UpdateRequest> ReadRequest(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("No se encontró system-update-request.json.", path);
        await using var stream = File.OpenRead(path);
        var request = await JsonSerializer.DeserializeAsync<UpdateRequest>(stream, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        });
        return request ?? throw new InvalidDataException("La solicitud de actualización no es válida.");
    }

    private static void ValidateRequest(UpdateRequest request)
    {
        if (request.SchemaVersion != 1) throw new InvalidDataException("Versión de solicitud de update no soportada.");
        if (!Uri.TryCreate(request.DownloadUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidDataException("La URL de actualización debe usar HTTPS.");
        if (request.Sha256.Length != 64 || request.Sha256.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidDataException("SHA-256 inválido.");
        if (request.Commit.Length != 40 || request.Commit.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidDataException("Commit de actualización inválido.");
        if (request.Port is <= 0 or > 65535) throw new InvalidDataException("Puerto de SOL inválido.");
    }

    private static async Task DownloadPackage(string url, string destination)
    {
        Log($"Downloading {url}");
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("SOL-Windows-Updater");
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync();
        await using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None);
        await input.CopyToAsync(output);
        await output.FlushAsync();
    }

    private static void VerifySha256(string path, string expected)
    {
        using var stream = File.OpenRead(path);
        var actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!actual.Equals(expected.Trim().ToLowerInvariant(), StringComparison.Ordinal))
            throw new InvalidDataException($"SHA-256 no coincide. Esperado {expected}; recibido {actual}.");
    }

    private static string ResolveExtractedPackageRoot(string stagingRoot)
    {
        var nested = Path.Combine(stagingRoot, "SOL");
        if (File.Exists(Path.Combine(nested, "SOL.exe"))) return nested;
        if (File.Exists(Path.Combine(stagingRoot, "SOL.exe"))) return stagingRoot;
        throw new InvalidDataException("El ZIP no contiene la carpeta portable de SOL esperada.");
    }

    private static void ValidateExtractedPackage(string packageRoot, UpdateRequest request)
    {
        foreach (var required in new[]
        {
            Path.Combine(packageRoot, "SOL.exe"),
            Path.Combine(packageRoot, "SOL.Updater.exe"),
            Path.Combine(packageRoot, "runtime", "node.exe"),
            Path.Combine(packageRoot, "apps", "server", "dist", "index.js"),
            Path.Combine(packageRoot, "version.json"),
        })
        {
            if (!File.Exists(required)) throw new InvalidDataException($"El paquete actualizado está incompleto: {required}");
        }

        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(packageRoot, "version.json")));
        var root = document.RootElement;
        var version = root.TryGetProperty("version", out var versionElement) ? versionElement.GetString() : null;
        var commit = root.TryGetProperty("commit", out var commitElement) ? commitElement.GetString() : null;
        if (!string.Equals(version, request.Version, StringComparison.Ordinal) ||
            !string.Equals(commit, request.Commit, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("version.json no coincide con el manifiesto publicado.");
    }

    private static async Task WaitForProcessExit(int pid, TimeSpan timeout)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            await process.WaitForExitAsync().WaitAsync(timeout);
        }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
    }

    private static async Task StopProcessesUsingInstallFamily(string root, TimeSpan timeout)
    {
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            var stoppedAny = false;
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    if (process.Id == Environment.ProcessId) continue;
                    string? executable = null;
                    try { executable = process.MainModule?.FileName; }
                    catch { continue; }
                    if (string.IsNullOrWhiteSpace(executable) || !IsInstallFamilyPath(executable, normalizedRoot)) continue;

                    try
                    {
                        Log($"Stopping residual SOL process pid={process.Id} image={executable}");
                        process.Kill(entireProcessTree: true);
                        stoppedAny = true;
                        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
                    }
                    catch (Exception ex)
                    {
                        Log($"Could not stop residual process pid={process.Id}: {ex.Message}");
                    }
                }
            }

            if (!stoppedAny) return;
            await Task.Delay(300);
        }
    }

    private static bool IsInstallFamilyPath(string executable, string root)
    {
        string full;
        try { full = Path.GetFullPath(executable); }
        catch { return false; }

        if (full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
        if (full.StartsWith(root + ".update-backup", StringComparison.OrdinalIgnoreCase)) return true;
        if (full.StartsWith(root + ".update-staging", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static async Task MoveDirectoryWithRetry(string source, string destination, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastError = null;
        var attempt = 0;

        while (DateTime.UtcNow < deadline)
        {
            attempt++;
            try
            {
                if (Directory.Exists(destination))
                    throw new IOException($"El destino ya existe: {destination}");
                Directory.Move(source, destination);
                if (attempt > 1) Log($"Directory move succeeded after {attempt} attempts: {source} -> {destination}");
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                lastError = ex;
                Log($"Directory move retry {attempt}: {source} -> {destination}: {ex.Message}");
                await Task.Delay(500);
            }
        }

        throw new IOException($"No se pudo mover {source} a {destination} después de {timeout.TotalSeconds:0} s.", lastError);
    }

    private static async Task DeleteDirectoryWithRetry(string path, TimeSpan timeout, bool throwOnTimeout)
    {
        if (!Directory.Exists(path)) return;
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastError = null;
        var attempt = 0;

        while (DateTime.UtcNow < deadline)
        {
            attempt++;
            try
            {
                Directory.Delete(path, recursive: true);
                if (attempt > 1) Log($"Directory delete succeeded after {attempt} attempts: {path}");
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                lastError = ex;
                Log($"Directory delete retry {attempt}: {path}: {ex.Message}");
                await Task.Delay(500);
            }
        }

        if (throwOnTimeout)
            throw new IOException($"No se pudo eliminar {path} después de {timeout.TotalSeconds:0} s.", lastError);
        Log($"Leaving stale directory for later cleanup: {path}: {lastError?.Message}");
    }

    private static void CleanupStaleUpdateDirectories(string root, params string[] keep)
    {
        var parent = Path.GetDirectoryName(root);
        var name = Path.GetFileName(root);
        if (string.IsNullOrWhiteSpace(parent) || string.IsNullOrWhiteSpace(name) || !Directory.Exists(parent)) return;
        var keepSet = new HashSet<string>(keep.Select(Path.GetFullPath), StringComparer.OrdinalIgnoreCase);

        foreach (var pattern in new[] { $"{name}.update-backup*", $"{name}.update-staging*" })
        {
            IEnumerable<string> directories;
            try { directories = Directory.EnumerateDirectories(parent, pattern, SearchOption.TopDirectoryOnly).ToArray(); }
            catch { continue; }
            foreach (var directory in directories)
            {
                var full = Path.GetFullPath(directory);
                if (keepSet.Contains(full)) continue;
                DeleteDirectoryBestEffort(full);
            }
        }
    }

    private static Process StartLauncher(string root)
    {
        var launcher = Path.Combine(root, "SOL.exe");
        var process = Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true });
        return process ?? throw new InvalidOperationException("No se pudo reiniciar SOL.exe.");
    }

    private static async Task<bool> WaitForHealth(int port, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            try
            {
                using var response = await client.GetAsync($"http://127.0.0.1:{port}/health");
                if (response.IsSuccessStatusCode) return true;
            }
            catch { }
            await Task.Delay(750);
        }
        return false;
    }

    private static void DeleteDirectoryBestEffort(string path)
    {
        if (!Directory.Exists(path)) return;
        try { Directory.Delete(path, recursive: true); }
        catch (Exception ex) { Log($"Could not delete directory {path}: {ex.Message}"); }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception ex) { Log($"Could not delete file {path}: {ex.Message}"); }
    }

    private static string SafeName(string value)
    {
        return string.Concat(value.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
    }

    private static void Log(string message)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(_logPath)) return;
            File.AppendAllText(_logPath, $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch { }
    }
}
