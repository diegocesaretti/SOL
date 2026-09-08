using System.Diagnostics;
using System.Net.Http;
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

    private sealed record PersistentPaths(string DataRoot, string EnvPath);

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
            OpenBrowser("http://127.0.0.1:3000/inputs/plugins/ui");
            return;
        }

        var root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var node = Path.Combine(root, "runtime", "node.exe");
        var server = Path.Combine(root, "apps", "server", "dist", "index.js");
        var example = Path.Combine(root, ".env.example");
        var persistent = ResolvePersistentPaths(root);
        var env = persistent.EnvPath;

        if (!File.Exists(node) || !File.Exists(server))
        {
            MessageBox(IntPtr.Zero, "El paquete de SOL está incompleto. Volvé a descargar SOL-Windows.zip.", "SOL", 0x10);
            return;
        }

        if (!File.Exists(env))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(env)!);
            if (File.Exists(example)) File.Copy(example, env, overwrite: false);
            ShowDatabaseConfiguration(env, firstRun: true);
            return;
        }

        var databaseUrl = ReadEnvValue(env, "DATABASE_URL");
        if (!HasConfiguredDatabaseUrl(databaseUrl))
        {
            ShowDatabaseConfiguration(env, firstRun: false);
            return;
        }

        var port = ReadPort(env, 3000);
        var baseUrl = $"http://127.0.0.1:{port}";
        var logDir = Path.Combine(persistent.DataRoot, "logs");
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
        child.StartInfo.Environment["SOL_DATA_DIR"] = persistent.DataRoot;
        child.StartInfo.Environment["SOL_ENV_FILE"] = env;
        child.OutputDataReceived += (_, e) => { if (e.Data is not null) lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] OUT {e.Data}"); };
        child.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] ERR {e.Data}"); };

        try
        {
            if (!child.Start()) throw new InvalidOperationException("No se pudo iniciar el servidor de SOL.");
            job.Assign(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();

            var ready = await WaitForHealth(baseUrl, TimeSpan.FromSeconds(30));
            if (ready) OpenBrowser(baseUrl + "/inputs/plugins/ui");
            else MessageBox(IntPtr.Zero, $"SOL no respondió a tiempo. Revisá el log:\n{logPath}", "SOL · error de inicio", 0x10);

            await child.WaitForExitAsync();
            if (child.ExitCode != 0)
            {
                MessageBox(IntPtr.Zero, $"SOL se cerró con código {child.ExitCode}. Revisá el log:\n{logPath}", "SOL", 0x10);
            }
        }
        catch (Exception ex)
        {
            lock (log) log.WriteLine($"[{DateTimeOffset.Now:O}] LAUNCHER {ex}");
            MessageBox(IntPtr.Zero, $"No se pudo iniciar SOL.\n\n{ex.Message}\n\nLog: {logPath}", "SOL", 0x10);
        }
    }

    private static PersistentPaths ResolvePersistentPaths(string root)
    {
        var explicitData = Environment.GetEnvironmentVariable("SOL_DATA_DIR")?.Trim();
        var explicitEnv = Environment.GetEnvironmentVariable("SOL_ENV_FILE")?.Trim();
        if (!string.IsNullOrWhiteSpace(explicitData))
        {
            var data = Path.GetFullPath(explicitData);
            Directory.CreateDirectory(data);
            return new PersistentPaths(data, !string.IsNullOrWhiteSpace(explicitEnv) ? Path.GetFullPath(explicitEnv) : Path.Combine(data, ".env"));
        }

        try
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(local)) throw new InvalidOperationException("LOCALAPPDATA no está disponible");
            var data = Path.Combine(local, "SOL");
            Directory.CreateDirectory(data);
            MigrateLegacyState(root, data);
            return new PersistentPaths(data, Path.Combine(data, ".env"));
        }
        catch
        {
            // Compatibility fallback: exactly the historical portable locations.
            return new PersistentPaths(Path.Combine(root, ".sol"), Path.Combine(root, ".env"));
        }
    }

    private static void MigrateLegacyState(string root, string dataRoot)
    {
        var marker = Path.Combine(dataRoot, ".legacy-portable-migration-v1");
        if (File.Exists(marker)) return;

        var legacyData = Path.Combine(root, ".sol");
        var legacyEnv = Path.Combine(root, ".env");
        if (Directory.Exists(legacyData)) CopyDirectoryMissing(legacyData, dataRoot);
        if (File.Exists(legacyEnv))
        {
            var targetEnv = Path.Combine(dataRoot, ".env");
            if (!File.Exists(targetEnv)) File.Copy(legacyEnv, targetEnv, overwrite: false);
        }
        File.WriteAllText(marker, $"Migrated {DateTimeOffset.Now:O}{Environment.NewLine}");
    }

    private static void CopyDirectoryMissing(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, directory);
            Directory.CreateDirectory(Path.Combine(destination, relative));
        }
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(source, file);
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (!File.Exists(target)) File.Copy(file, target, overwrite: false);
        }
    }

    private static void ShowDatabaseConfiguration(string envPath, bool firstRun)
    {
        var prefix = firstRun
            ? "Es el primer inicio de SOL. Se creó la configuración en la carpeta de datos persistentes de SOL."
            : "SOL detectó que DATABASE_URL todavía contiene valores de ejemplo o está vacío.";

        MessageBox(IntPtr.Zero,
            $"{prefix}\n\nPegá en DATABASE_URL la cadena de conexión real de Neon, guardá el archivo y volvé a abrir SOL.\n\nSOL no iniciará servicios hasta que la base esté configurada.\n\nArchivo: {envPath}",
            "SOL · configurar Neon",
            0x40);

        if (File.Exists(envPath))
        {
            Process.Start(new ProcessStartInfo("notepad.exe", $"\"{envPath}\"") { UseShellExecute = true });
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
        if (!uri.Scheme.Equals("postgresql", StringComparison.OrdinalIgnoreCase) &&
            !uri.Scheme.Equals("postgres", StringComparison.OrdinalIgnoreCase)) return false;

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
                if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, pointer, (uint)length))
                    throw new InvalidOperationException("No se pudo configurar el job de procesos de SOL.");
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(_handle, process.Handle))
                throw new InvalidOperationException("No se pudo asociar el servidor al launcher de SOL.");
        }

        public void Dispose()
        {
            if (_handle == IntPtr.Zero) return;
            CloseHandle(_handle);
            _handle = IntPtr.Zero;
        }
    }
}
