// The worker adapter: tests a Windows service or a .NET worker by what it does. It drops a case's
// input file, waits until the worker has finished, and reports the output files and the event log
// entries, without times or process ids. See README.md. Program.cs is the template's, unchanged.
using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

/// <summary>A safety rule or a setting said no. The message is what the person needs to fix it.</summary>
sealed class Refused(string message) : Exception(message);

public static class Adapter
{
    const string TestMachineVariable = "CMTK_WORKER_TEST_MACHINE";
    const int LargestTextFile = 256 * 1024;
    static readonly Dictionary<string, Process> Started = new();

    public static JsonObject Describe() => new()
    {
        ["name"] = "worker",
        ["kinds"] = new JsonArray("worker", "files", "logs"),
        ["settings"] = new JsonArray("test_area", "input_folder", "output_folder", "baseline_folder", "service", "start", "finish", "finish_quiet_ms", "finish_timeout_s", "event_source", "event_log"),
    };

    public static async Task<JsonObject> Run(JsonObject testCase, JsonObject target, IReadOnlyDictionary<string, string> headers)
    {
        // `headers` is not used: nothing here needs a credential, so none can be reported.
        var s = Settings.From(target);
        var request = testCase["request"] as JsonObject ?? throw new Refused("the case has no request");
        foreach (var field in new[] { "before", "body_form", "files" })
        {
            if (testCase[field] is not null || request[field] is not null) throw new Refused($"the worker adapter does not support {field}: give the input as body or body_file");
        }
        var method = request["method"]?.GetValue<string>()?.ToUpperInvariant();
        if (method is "GET" or "HEAD" or "OPTIONS") return Observation(s, null);
        if (method is not ("POST" or "PUT")) throw new Refused($"the worker adapter drops a file for POST or PUT, and only reads for GET, HEAD or OPTIONS, not {method}");

        var input = s.InputFile(request["path"]?.GetValue<string>());
        var bytes = InputBytes(request);
        Directory.CreateDirectory(s.Input);
        Directory.CreateDirectory(s.Output);
        await Start(s);
        var lastEvent = s.EventSource is null ? 0 : LastEventRecord(s);
        if (s.Marker is not null) File.Delete(s.Marker);

        // Written beside the folder and then moved, so the worker never sees half a file.
        var partial = Path.Combine(s.Area, $".cmtk-drop-{Guid.NewGuid():N}");
        await File.WriteAllBytesAsync(partial, bytes);
        Directory.CreateDirectory(Path.GetDirectoryName(input)!);
        File.Move(partial, input, overwrite: true);

        await WaitUntilFinished(s, input);
        return Observation(s, lastEvent);
    }

    public static async Task<JsonObject> Reset(JsonObject target)
    {
        var s = Settings.From(target);
        await Stop(s);
        Directory.CreateDirectory(s.Input);
        Directory.CreateDirectory(s.Output);
        await Clear(s.Input);
        await Clear(s.Output);
        if (s.Baseline is not null)
        {
            CopyFolder(Path.Combine(s.Baseline, "input"), s.Input);
            CopyFolder(Path.Combine(s.Baseline, "output"), s.Output);
        }
        await Start(s);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Stops the workers this adapter started. A service stays as it is: `reset` is what stops one.</summary>
    public static void Close()
    {
        foreach (var process in Started.Values) Kill(process);
        Started.Clear();
    }

    static byte[] InputBytes(JsonObject request)
    {
        if (request["body_file"]?.GetValue<string>() is { } file) return File.ReadAllBytes(Path.GetFullPath(file));
        return request["body"] switch
        {
            null => [],
            JsonValue v when v.TryGetValue<string>(out var text) => new UTF8Encoding(false).GetBytes(text),
            var other => new UTF8Encoding(false).GetBytes(other.ToJsonString()),
        };
    }

    static async Task Start(Settings s)
    {
        if (s.Service is not null)
        {
            RequireTestMachine(s);
            if (ServiceState(s) != ServiceRunning)
            {
                Tool("sc.exe", "start", s.Service);
                await WaitForService(s, ServiceRunning);
            }
            return;
        }
        if (Started.TryGetValue(s.Name, out var running))
        {
            if (!running.HasExited) return;
            running.Dispose();
            Started.Remove(s.Name);
        }
        var (file, arguments) = SplitCommand(s.Start!);
        var info = new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            // The worker must never touch the protocol: stdin stays closed, and what it prints goes to stderr.
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.Environment["CMTK_WORKER_INPUT_FOLDER"] = s.Input;
        info.Environment["CMTK_WORKER_OUTPUT_FOLDER"] = s.Output;
        Process process;
        try
        {
            process = Process.Start(info) ?? throw new Refused($"could not start the worker for {s.Name}");
        }
        catch (Win32Exception err)
        {
            throw new Refused($"could not start the worker for {s.Name}: {file}: {err.Message}");
        }
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) Console.Error.WriteLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) Console.Error.WriteLine(e.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        process.StandardInput.Close();
        Started[s.Name] = process;
    }

    static async Task Stop(Settings s)
    {
        if (s.Service is not null)
        {
            RequireTestMachine(s);
            if (ServiceState(s) != ServiceStopped)
            {
                Tool("sc.exe", "stop", s.Service);
                await WaitForService(s, ServiceStopped);
            }
            return;
        }
        if (Started.Remove(s.Name, out var process)) Kill(process);
    }

    static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(10_000);
        }
        catch (Exception err) when (err is InvalidOperationException or Win32Exception)
        {
            // It had already stopped, or was stopping.
        }
        process.Dispose();
    }

    const int ServiceStopped = 1;
    const int ServiceRunning = 4;

    /// <summary>Starting or stopping a service is refused unless a person has named this machine as a test machine.</summary>
    static void RequireTestMachine(Settings s)
    {
        var named = Environment.GetEnvironmentVariable(TestMachineVariable);
        if (!string.Equals(named, Environment.MachineName, StringComparison.OrdinalIgnoreCase))
        {
            throw new Refused($"refusing to control the service {s.Service}: set {TestMachineVariable} to this machine's name to say it is a test machine. Never do this on a shared or production machine");
        }
    }

    // The number is the same in every language of Windows; the word beside it is not.
    static int ServiceState(Settings s)
    {
        var state = Regex.Match(Tool("sc.exe", "query", s.Service!), @"STATE\s*:\s*(\d+)");
        return state.Success ? int.Parse(state.Groups[1].Value) : throw new Refused($"sc.exe did not give the state of the service {s.Service}");
    }

    static async Task WaitForService(Settings s, int wanted)
    {
        var clock = Stopwatch.StartNew();
        while (ServiceState(s) != wanted)
        {
            if (clock.Elapsed.TotalSeconds > s.TimeoutSeconds) throw new Refused($"the service {s.Service} did not reach state {wanted} within {s.TimeoutSeconds}s");
            await Task.Delay(100);
        }
    }

    /// <summary>Runs an in-box Windows tool with no shell, and returns what it printed.</summary>
    static string Tool(string file, params string[] arguments)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(info) ?? throw new Refused($"could not start {file}");
            process.StandardInput.Close();
            var error = process.StandardError.ReadToEndAsync();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new Refused($"{file} {arguments[0]} failed with exit code {process.ExitCode}: {(output + error.Result).Trim()}");
            return output;
        }
        catch (Win32Exception err)
        {
            throw new Refused($"could not start {file}, which is part of Windows: {err.Message}");
        }
    }

    static async Task WaitUntilFinished(Settings s, string input)
    {
        var clock = Stopwatch.StartNew();
        var quiet = Stopwatch.StartNew();
        var last = Fingerprint(s);
        while (true)
        {
            if (s.Service is null && Started[s.Name].HasExited) throw new Refused($"the worker for {s.Name} stopped while the case ran, with exit code {Started[s.Name].ExitCode}");
            var now = Fingerprint(s);
            if (now != last)
            {
                last = now;
                quiet.Restart();
            }
            var signalled = s.Finish switch
            {
                "input-gone" => !File.Exists(input),
                "quiet" => true,
                _ => File.Exists(s.Marker!),
            };
            if (signalled && quiet.ElapsedMilliseconds >= s.QuietMs) return;
            if (clock.Elapsed.TotalSeconds > s.TimeoutSeconds) throw new Refused($"the worker for {s.Name} did not finish within {s.TimeoutSeconds}s (finish: {s.Finish})");
            await Task.Delay(25);
        }
    }

    /// <summary>What changes while the worker writes. It is used only to wait, and never reported.</summary>
    static string Fingerprint(Settings s)
    {
        var text = new StringBuilder();
        foreach (var file in OutputFiles(s))
        {
            var info = new FileInfo(file);
            if (info.Exists) text.Append(file).Append('|').Append(info.Length).Append('|').Append(info.LastWriteTimeUtc.Ticks).Append('\n');
        }
        return text.ToString();
    }

    static IEnumerable<string> OutputFiles(Settings s)
    {
        if (!Directory.Exists(s.Output)) return [];
        // Links are not followed, so a link cannot show what is outside the test area.
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        return Directory.EnumerateFiles(s.Output, "*", options).Where(f => f != s.Marker);
    }

    static JsonObject Observation(Settings s, long? lastEvent)
    {
        var outputs = new JsonArray();
        foreach (var file in OutputFiles(s).Select(f => (Full: f, Name: Path.GetRelativePath(s.Output, f).Replace('\\', '/'))).OrderBy(f => f.Name, StringComparer.Ordinal))
        {
            outputs.Add(Report(file.Full, file.Name));
        }
        var effects = new JsonObject { ["outputs"] = outputs };
        if (lastEvent is not null && s.EventSource is not null) effects["events"] = EventsSince(s, lastEvent.Value);
        return new JsonObject { ["status"] = 200, ["effects"] = effects };
    }

    /// <summary>A file's name, size and text. A binary or very large file gives its hash in place of its text.</summary>
    static JsonObject Report(string file, string name)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var bytes = new byte[stream.Length];
        stream.ReadExactly(bytes);
        var report = new JsonObject { ["path"] = name, ["bytes"] = bytes.Length };
        try
        {
            if (bytes.Length > LargestTextFile || bytes.Contains((byte)0)) throw new DecoderFallbackException();
            report["text"] = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            report["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        }
        return report;
    }

    static long LastEventRecord(Settings s)
    {
        var record = Regex.Match(Tool("wevtutil.exe", "qe", s.EventLog, "/c:1", "/rd:true", "/f:xml"), @"<EventRecordID>(\d+)</EventRecordID>");
        return record.Success ? long.Parse(record.Groups[1].Value) : 0;
    }

    /// <summary>The entries this service wrote since `after`: its source, level, id and message. No times, process ids, machine or user.</summary>
    static JsonArray EventsSince(Settings s, long after)
    {
        var query = $"*[System[Provider[@Name='{s.EventSource}'] and EventRecordID > {after}]]";
        var xml = XDocument.Parse(Tool("wevtutil.exe", "qe", s.EventLog, $"/q:{query}", "/f:RenderedXml", "/e:Events"));
        var events = new JsonArray();
        foreach (var entry in xml.Descendants().Where(e => e.Name.LocalName == "Event"))
        {
            var value = (string name) => entry.Descendants().FirstOrDefault(e => e.Name.LocalName == name)?.Value;
            var message = value("Message") ?? string.Join(" ", entry.Descendants().Where(e => e.Name.LocalName == "Data").Select(e => e.Value));
            events.Add(new JsonObject
            {
                ["source"] = s.EventSource,
                ["level"] = value("Level"),
                ["id"] = value("EventID"),
                ["message"] = WithoutTimesOrIds(message),
            });
        }
        return events;
    }

    /// <summary>Messages often carry a time or a process id, which would differ on every run.</summary>
    static string WithoutTimesOrIds(string message)
    {
        var text = Regex.Replace(message, @"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?", "<time>");
        text = Regex.Replace(text, @"\b\d{1,2}/\d{1,2}/\d{2,4}\b", "<date>");
        text = Regex.Replace(text, @"\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b", "<time>");
        text = Regex.Replace(text, @"\b(pid|tid|process id|processid|thread id|threadid)(\s*[:=#]?\s*)\d+", "$1$2<id>", RegexOptions.IgnoreCase);
        return text.Replace("\r\n", "\n").Trim();
    }

    /// <summary>Empties a folder. Links are removed, and what they point at is left alone.</summary>
    static async Task Clear(string folder)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                foreach (var entry in new DirectoryInfo(folder).EnumerateFileSystemInfos("*", new EnumerationOptions { AttributesToSkip = 0 }))
                {
                    if (entry is DirectoryInfo directory) directory.Delete(recursive: true);
                    else entry.Delete();
                }
                return;
            }
            // A stopped service can hold a file for a moment longer on Windows.
            catch (Exception err) when (attempt < 20 && err is IOException or UnauthorizedAccessException)
            {
                await Task.Delay(250);
            }
        }
    }

    static void CopyFolder(string from, string to)
    {
        if (!Directory.Exists(from)) return;
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var file in Directory.EnumerateFiles(from, "*", options))
        {
            var copy = Path.Combine(to, Path.GetRelativePath(from, file));
            Directory.CreateDirectory(Path.GetDirectoryName(copy)!);
            File.Copy(file, copy, overwrite: true);
        }
    }

    /// <summary>The program, and the rest of the line. There is no shell, so nothing here is expanded.</summary>
    static (string File, string Arguments) SplitCommand(string command)
    {
        var line = command.Trim();
        var end = line.StartsWith('"') ? line.IndexOf('"', 1) : line.IndexOf(' ');
        if (line.StartsWith('"') && end < 0) throw new Refused("start has an opening quote with no closing quote");
        if (end < 0) return (line, "");
        return (line[(line.StartsWith('"') ? 1 : 0)..end], line[(end + 1)..].Trim());
    }
}

/// <summary>A target's settings from cmtk.yaml, read afresh and checked before anything is touched.</summary>
sealed class Settings
{
    public required string Name, Area, Input, Output, Finish, EventLog;
    public string? Baseline, Service, Start, Marker, EventSource;
    public int QuietMs, TimeoutSeconds;

    static readonly StringComparison PathComparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    static readonly Regex EventName = new(@"^[A-Za-z0-9 ._/-]{1,128}$");

    public static Settings From(JsonObject target)
    {
        string? Text(string key) => target[key] is JsonValue v && v.TryGetValue<string>(out var text) && text.Length > 0 ? text : null;
        int Number(string key, int fallback, int largest)
        {
            if (target[key] is null) return fallback;
            if (target[key] is JsonValue v && v.TryGetValue<int>(out var n) && n >= 0 && n <= largest) return n;
            throw new Refused($"{key} must be a whole number from 0 to {largest}");
        }
        string Needed(string key) => Text(key) ?? throw new Refused($"the worker adapter needs {key} in this target's settings in cmtk.yaml");

        var name = Text("name") ?? "target";
        var area = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Needed("test_area")));
        CheckArea(area);
        string Folder(string key, string value)
        {
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value, area));
            if (!Inside(area, full)) throw new Refused($"{key} {full} is outside the test area {area}. The adapter only works inside the test area");
            RefuseLinks(key, area, full);
            return full;
        }
        var input = Folder("input_folder", Needed("input_folder"));
        var output = Folder("output_folder", Needed("output_folder"));
        var baseline = Text("baseline_folder") is { } b ? Folder("baseline_folder", b) : null;
        if (Overlap(input, output)) throw new Refused("input_folder and output_folder must be separate folders");
        if (baseline is not null && (Overlap(baseline, input) || Overlap(baseline, output))) throw new Refused("baseline_folder must be separate from input_folder and output_folder");

        var service = Text("service");
        var start = Text("start");
        if ((service is null) == (start is null)) throw new Refused("give exactly one of service (a Windows service) or start (the command that runs a worker)");
        if (service is not null && !Regex.IsMatch(service, @"^[A-Za-z0-9 ._$-]{1,256}$")) throw new Refused("service is not a valid service name");

        var finish = Needed("finish");
        string? marker = null;
        if (finish.StartsWith("file:"))
        {
            marker = Path.GetFullPath(finish["file:".Length..], output);
            if (!Inside(output, marker)) throw new Refused("finish: file: must name a file inside output_folder");
        }
        else if (finish is not ("input-gone" or "quiet"))
        {
            throw new Refused("finish must be input-gone, quiet, or file:<a file in output_folder>");
        }

        var source = Text("event_source");
        var log = Text("event_log") ?? "Application";
        if (source is not null && !EventName.IsMatch(source)) throw new Refused("event_source has characters an event source name cannot have");
        if (!EventName.IsMatch(log)) throw new Refused("event_log has characters an event log name cannot have");

        return new Settings
        {
            Name = name, Area = area, Input = input, Output = output, Baseline = baseline, Service = service, Start = start, Finish = finish, Marker = marker,
            EventSource = source, EventLog = log, QuietMs = Number("finish_quiet_ms", 300, 600_000), TimeoutSeconds = Number("finish_timeout_s", 30, 3600),
        };
    }

    /// <summary>Where a case's request path lands. It is a file inside input_folder, or the case is refused.</summary>
    public string InputFile(string? requestPath)
    {
        var relative = (requestPath ?? "").TrimStart('/', '\\');
        if (relative.Length == 0 || relative.Contains(':') || relative.Contains('?')) throw new Refused($"the request path must name a file in input_folder, such as /order.json, not {requestPath}");
        var full = Path.GetFullPath(relative, Input);
        if (!Inside(Input, full)) throw new Refused($"the request path {requestPath} is outside input_folder");
        RefuseLinks("the request path", Input, Path.GetDirectoryName(full)!);
        return full;
    }

    static void CheckArea(string area)
    {
        if (!Directory.Exists(area)) throw new Refused($"test_area {area} does not exist. A person creates it, on a test machine");
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var tooBroad = Path.GetPathRoot(area) == area + Path.DirectorySeparatorChar || Path.GetPathRoot(area) == area
            || (home.Length > 0 && (string.Equals(area, home, PathComparison) || Inside(area, home)));
        if (tooBroad) throw new Refused($"test_area {area} is too broad. Use a folder that holds nothing but this test's files");
    }

    static bool Inside(string parent, string child) =>
        child.StartsWith(parent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, PathComparison) && child.Length > parent.Length + 1;

    static bool Overlap(string a, string b) => string.Equals(a, b, PathComparison) || Inside(a, b) || Inside(b, a);

    /// <summary>A link inside the test area could lead out of it, so none is allowed on the way to a folder.</summary>
    static void RefuseLinks(string key, string area, string full)
    {
        for (var at = full; at is not null && !string.Equals(at, area, PathComparison) && Inside(area, at); at = Path.GetDirectoryName(at))
        {
            if (new DirectoryInfo(at).LinkTarget is not null) throw new Refused($"{key} goes through a link at {at}, which could lead outside the test area");
        }
    }
}
