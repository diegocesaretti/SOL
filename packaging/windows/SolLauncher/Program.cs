using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace SolLauncher;

internal static class Program
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr hJob, uint infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    [STAThread]
    private static async Task Main()
    {
        using var singleton = new Mutex(true, "Local\\SOL.Desktop.Singleton", out var firstInstance);
        if (!firstInstance)
        {
            OpenBrowser("http://127.0.0.1:3000/");
            return;
        }

        var root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var node = Path.Combine(root, "runtime", "node.exe");
        var server = Path.Combine(root, "apps", "server", "dist", "index.js");
        var migrate = Path.Combine(root, "apps", "server", "dist", "database", "migrate.js");
        var env = Path.Combine(root, ".env");
        var example = Path.Combine(root, ".env.example");

        if (!File.Exists(node) || !File.Exists(server) || !File.Exists(migrate))
        {
            MessageBox(IntPtr.Zero, "El paquete de SOL está incompleto. Volvé a descargar SOL-Windows.zip.", "SOL", 0x10);
            return;
        }

        while (true)
        {
            if (!File.Exists(env) && File.Exists(example)) File.Copy(example, env, overwrite: false);

            string? setupError = null;
            while (true)
            {
                var databaseUrl = ReadEnvValue(env, "DATABASE_URL");
                if (!HasConfiguredDatabaseUrl(databaseUrl) || setupError is not null)
                {
                    var configured = await ConfigureDatabaseInBrowser(env, setupError);
                    if (!configured) return;
                    setupError = null;
                }

                var migration = await RunDatabaseMigration(root, node, migrate);
                if (migration.Ok) break;
                setupError = "No se pudo conectar o preparar Neon. Revisá la URL y volvé a guardarla.\n\n" + migration.Error;
            }

            var exitCode = await RunServer(root, node, server, env);
            if (exitCode == 42 || File.Exists(Path.Combine(root, ".sol", "factory-reset-requested")))
            {
                PerformFactoryReset(root, env);
                continue;
            }
            if (exitCode == 43) continue;
            return;
        }
    }

    private static async Task<int> RunServer(string root, string node, string server, string env)
    {
        var port = ReadPort(env, 3000);
        var baseUrl = $"http://127.0.0.1:{port}";
        var logDir = Path.Combine(root, ".sol", "logs");
        Directory.CreateDirectory(logDir);
        var logPath = Path.Combine(logDir, "server.log");

        using var job = new JobHandle();
        using var log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8) { AutoFlush = true };
        using var child = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = $"\"{server}\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
            EnableRaisingEvents = true,
        };

        child.StartInfo.Environment["SOL_LAUNCHER_PID"] = Environment.ProcessId.ToString();
        child.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] OUT {e.Data}"); };
        child.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] ERR {e.Data}"); };

        try
        {
            if (!child.Start()) throw new InvalidOperationException("No se pudo iniciar el servidor de SOL.");
            job.Assign(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            var ready = await WaitForHealth(baseUrl, TimeSpan.FromSeconds(30));
            if (ready) OpenBrowser(baseUrl + "/");
            else
            {
                MessageBox(IntPtr.Zero, $"SOL no respondió a tiempo. Revisá el log:\n{logPath}", "SOL · error de inicio", 0x10);
                try { child.Kill(entireProcessTree: true); } catch { }
            }

            await child.WaitForExitAsync();
            if (child.ExitCode != 0 && child.ExitCode is not 42 and not 43)
                MessageBox(IntPtr.Zero, $"SOL se cerró con código {child.ExitCode}. Revisá el log:\n{logPath}", "SOL", 0x10);
            return child.ExitCode;
        }
        catch (Exception ex)
        {
            lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] LAUNCHER {ex}");
            MessageBox(IntPtr.Zero, $"No se pudo iniciar SOL.\n\n{ex.Message}\n\nLog: {logPath}", "SOL", 0x10);
            return -1;
        }
    }

    private static async Task<(bool Ok, string Error)> RunDatabaseMigration(string root, string node, string migrationEntry)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = node,
                Arguments = $"\"{migrationEntry}\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        try
        {
            if (!process.Start()) return (false, "No se pudo iniciar el migrador de SOL.");
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(75));
            await process.WaitForExitAsync(timeout.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (process.ExitCode == 0) return (true, "");
            var detail = string.Join("\n", new[] { stderr, stdout }.Where(x => !string.IsNullOrWhiteSpace(x))).Trim();
            return (false, detail.Length > 1800 ? detail[..1800] : detail);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return (false, "La conexión con Neon agotó el tiempo de espera.");
        }
        catch (Exception ex) { return (false, ex.Message); }
    }

    private static async Task<bool> ConfigureDatabaseInBrowser(string envPath, string? error)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var token = Guid.NewGuid().ToString("N");
        var path = $"/setup/{token}";
        var url = $"http://127.0.0.1:{port}{path}";
        OpenBrowser(url);

        try
        {
            while (true)
            {
                using var client = await listener.AcceptTcpClientAsync();
                using var stream = client.GetStream();
                var request = await ReadHttpRequest(stream);
                if (request is null) continue;
                if (!request.Path.Equals(path, StringComparison.Ordinal))
                {
                    await WriteHttpResponse(stream, 404, "text/plain; charset=utf-8", "Not found");
                    continue;
                }

                if (request.Method == "GET")
                {
                    await WriteHttpResponse(stream, 200, "text/html; charset=utf-8", DatabaseSetupHtml(error));
                    error = null;
                    continue;
                }

                if (request.Method == "POST")
                {
                    var form = ParseForm(request.Body);
                    form.TryGetValue("databaseUrl", out var databaseUrl);
                    databaseUrl = databaseUrl?.Trim();
                    if (!HasConfiguredDatabaseUrl(databaseUrl))
                    {
                        await WriteHttpResponse(stream, 400, "text/html; charset=utf-8", DatabaseSetupHtml("La URL no parece una conexión PostgreSQL válida de Neon."));
                        continue;
                    }
                    UpsertEnvValue(envPath, "DATABASE_URL", databaseUrl!);
                    await WriteHttpResponse(stream, 200, "text/html; charset=utf-8", SuccessSetupHtml());
                    return true;
                }

                await WriteHttpResponse(stream, 405, "text/plain; charset=utf-8", "Method not allowed");
            }
        }
        catch (Exception ex)
        {
            MessageBox(IntPtr.Zero, $"No se pudo abrir el asistente de Neon.\n\n{ex.Message}", "SOL · configurar Neon", 0x10);
            return false;
        }
        finally { listener.Stop(); }
    }

    private sealed record SimpleHttpRequest(string Method, string Path, string Body);

    private static async Task<SimpleHttpRequest?> ReadHttpRequest(NetworkStream stream)
    {
        var header = new List<byte>();
        var tail = new Queue<byte>(4);
        var one = new byte[1];
        while (header.Count < 32768)
        {
            var read = await stream.ReadAsync(one);
            if (read == 0) return null;
            header.Add(one[0]);
            tail.Enqueue(one[0]);
            while (tail.Count > 4) tail.Dequeue();
            if (tail.Count == 4 && tail.SequenceEqual(new byte[] { 13, 10, 13, 10 })) break;
        }
        var headerText = Encoding.ASCII.GetString(header.ToArray());
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        var first = lines.FirstOrDefault()?.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (first is null || first.Length < 2) return null;
        var length = 0;
        foreach (var line in lines)
        {
            var index = line.IndexOf(':');
            if (index <= 0) continue;
            if (line[..index].Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) int.TryParse(line[(index + 1)..].Trim(), out length);
        }
        length = Math.Clamp(length, 0, 131072);
        var bodyBytes = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(bodyBytes.AsMemory(offset, length - offset));
            if (read == 0) break;
            offset += read;
        }
        return new SimpleHttpRequest(first[0].ToUpperInvariant(), first[1], Encoding.UTF8.GetString(bodyBytes, 0, offset));
    }

    private static async Task WriteHttpResponse(NetworkStream stream, int status, string contentType, string body)
    {
        var payload = Encoding.UTF8.GetBytes(body);
        var reason = status switch { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", _ => "OK" };
        var headers = Encoding.ASCII.GetBytes($"HTTP/1.1 {status} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {payload.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(headers);
        await stream.WriteAsync(payload);
        await stream.FlushAsync();
    }

    private static Dictionary<string, string> ParseForm(string body)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            var key = FormDecode(parts[0]);
            var value = parts.Length > 1 ? FormDecode(parts[1]) : "";
            result[key] = value;
        }
        return result;
    }

    private static string FormDecode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static string DatabaseSetupHtml(string? error)
    {
        var errorHtml = string.IsNullOrWhiteSpace(error) ? "" : $"<div class='error'>{Html(error)}</div>";
        return $"""
<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SOL · Neon</title>
<style>:root{{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif;background:#0a0c10;color:#f4f6f8}}*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}}.box{{width:min(680px,100%);background:#11141a;border:1px solid #262b35;border-radius:22px;padding:26px}}.mark{{width:40px;height:40px;border-radius:12px;background:#f4f6f8;color:#0a0c10;display:grid;place-items:center;font-weight:900}}h1{{font-size:38px;letter-spacing:-.04em;margin:16px 0 8px}}p{{color:#9299a6;line-height:1.55}}label{{display:grid;gap:7px;font-size:13px;font-weight:700;color:#9299a6;margin-top:20px}}input{{width:100%;padding:12px;border-radius:11px;border:1px solid #262b35;background:#0d1015;color:#f4f6f8;font:inherit}}button{{margin-top:14px;border:0;border-radius:11px;padding:11px 15px;background:#f4f6f8;color:#0a0c10;font-weight:850;cursor:pointer}}.small{{font-size:12px}}.error{{margin-top:14px;padding:12px;border:1px solid #62333a;border-radius:12px;color:#ff8d8d;background:#241417;white-space:pre-wrap}}code{{font-family:Consolas,monospace}}</style></head><body><main class="box"><div class="mark">S</div><h1>Conectar SOL con Neon.</h1><p>Este es el primer paso. Pegá la cadena <strong>PostgreSQL connection string</strong> de tu proyecto Neon. SOL la guarda únicamente en el <code>.env</code> local y después prepara automáticamente la base.</p>{errorHtml}<form method="post"><label>URL de Neon<input id="db" name="databaseUrl" type="password" autocomplete="off" spellcheck="false" placeholder="postgresql://usuario:contraseña@host.neon.tech/database?sslmode=require" required></label><label style="display:flex;grid-template-columns:auto 1fr;align-items:center;gap:8px"><input id="show" type="checkbox" style="width:auto"> Mostrar URL mientras la reviso</label><button>Guardar y continuar</button></form><p class="small">No necesitás abrir ni editar archivos de texto. En futuros arranques SOL ejecutará las migraciones pendientes automáticamente.</p><script>document.getElementById('show').onchange=e=>document.getElementById('db').type=e.target.checked?'text':'password';</script></main></body></html>
""";
    }

    private static string SuccessSetupHtml() => """
<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4;url=http://127.0.0.1:3000/"><title>SOL</title><style>:root{color-scheme:dark;font-family:Inter,Segoe UI,sans-serif;background:#0a0c10;color:#f4f6f8}body{margin:0;min-height:100vh;display:grid;place-items:center}.box{text-align:center}.dot{width:12px;height:12px;border-radius:50%;background:#58d68d;display:inline-block;margin-right:8px}</style></head><body><div class="box"><h1><span class="dot"></span>Neon guardado.</h1><p>SOL está verificando la conexión y preparando la base…</p></div></body></html>
""";

    private static string Html(string value) => WebUtility.HtmlEncode(value);

    private static void UpsertEnvValue(string envPath, string key, string value)
    {
        var lines = File.Exists(envPath) ? File.ReadAllLines(envPath).ToList() : new List<string>();
        var found = false;
        for (var i = 0; i < lines.Count; i++)
        {
            var trimmed = lines[i].TrimStart();
            if (trimmed.StartsWith("#")) continue;
            var equals = trimmed.IndexOf('=');
            if (equals <= 0 || !trimmed[..equals].Trim().Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
            lines[i] = $"{key}={value}";
            found = true;
            break;
        }
        if (!found) lines.Add($"{key}={value}");
        var temporary = envPath + ".tmp";
        File.WriteAllLines(temporary, lines, new UTF8Encoding(false));
        File.Move(temporary, envPath, true);
    }

    private static void PerformFactoryReset(string root, string envPath)
    {
        try { if (File.Exists(envPath)) File.Delete(envPath); } catch { }
        var solDir = Path.Combine(root, ".sol");
        if (!Directory.Exists(solDir)) return;
        foreach (var directory in Directory.GetDirectories(solDir))
        {
            if (Path.GetFileName(directory).Equals("logs", StringComparison.OrdinalIgnoreCase)) continue;
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
        foreach (var file in Directory.GetFiles(solDir))
        {
            try { File.Delete(file); } catch { }
        }
    }

    private static string? ReadEnvValue(string envPath, string key)
    {
        try
        {
            foreach (var line in File.ReadLines(envPath))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
                var equals = trimmed.IndexOf('=');
                if (equals <= 0) continue;
                if (!trimmed[..equals].Trim().Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
                return trimmed[(equals + 1)..].Trim().Trim('"');
            }
        }
        catch { }
        return null;
    }

    private static bool HasConfiguredDatabaseUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
        if (!uri.Scheme.Equals("postgresql", StringComparison.OrdinalIgnoreCase) && !uri.Scheme.Equals("postgres", StringComparison.OrdinalIgnoreCase)) return false;
        var host = uri.Host.Trim().ToLowerInvariant();
        if (host.Length == 0 || host is "host" or "localhost.example") return false;
        var userInfo = Uri.UnescapeDataString(uri.UserInfo ?? string.Empty).ToLowerInvariant();
        if (userInfo.Length == 0 || userInfo.StartsWith("user:") || userInfo.Contains(":password")) return false;
        var database = uri.AbsolutePath.Trim('/').ToLowerInvariant();
        if (database.Length == 0 || database == "database") return false;
        return true;
    }

    private static int ReadPort(string envPath, int fallback)
    {
        try
        {
            foreach (var line in File.ReadLines(envPath))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith("#") || !trimmed.StartsWith("SOL_PORT=", StringComparison.OrdinalIgnoreCase)) continue;
                if (int.TryParse(trimmed["SOL_PORT=".Length..].Trim(), out var port) && port is > 0 and <= 65535) return port;
            }
        }
        catch { }
        return fallback;
    }

    private static async Task<bool> WaitForHealth(string baseUrl, TimeSpan timeout)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            try
            {
                using var response = await client.GetAsync(baseUrl + "/health");
                if (response.IsSuccessStatusCode) return true;
            }
            catch { }
            await Task.Delay(500);
        }
        return false;
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private sealed class JobHandle : IDisposable
    {
        private IntPtr _handle;

        public JobHandle()
        {
            _handle = CreateJobObject(IntPtr.Zero, null);
            if (_handle == IntPtr.Zero) throw new InvalidOperationException("No se pudo crear el job de procesos de SOL.");
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, pointer, (uint)length)) throw new InvalidOperationException("No se pudo configurar el job de procesos de SOL.");
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(_handle, process.Handle)) throw new InvalidOperationException("No se pudo asociar el servidor al launcher de SOL.");
        }

        public void Dispose()
        {
            if (_handle == IntPtr.Zero) return;
            CloseHandle(_handle);
            _handle = IntPtr.Zero;
        }
    }
}
