// A tiny worker to test the adapter against. It takes each file from its input folder, writes
// <name>.out.txt to its output folder with the lines in capitals, and removes the input.
//   --drop-last-line        a planted bug, for a comparison to catch
//   --done-file <name>      writes this file to the output folder when a file is finished
//   --event-source <name>   also writes a Windows event log entry (Windows only, uses eventcreate.exe)
using System.Diagnostics;

var input = Environment.GetEnvironmentVariable("CMTK_WORKER_INPUT_FOLDER") ?? throw new InvalidOperationException("CMTK_WORKER_INPUT_FOLDER is not set");
var output = Environment.GetEnvironmentVariable("CMTK_WORKER_OUTPUT_FOLDER") ?? throw new InvalidOperationException("CMTK_WORKER_OUTPUT_FOLDER is not set");
var dropLastLine = args.Contains("--drop-last-line");
string? Option(string name) => Array.IndexOf(args, name) is >= 0 and var i && i + 1 < args.Length ? args[i + 1] : null;
var doneFile = Option("--done-file");
var eventSource = Option("--event-source");

// A time and a process id on standard output: what a real worker logs, and the adapter must not report.
Console.WriteLine($"{DateTime.UtcNow:O} sample worker started, pid {Environment.ProcessId}");

while (true)
{
    foreach (var file in Directory.Exists(input) ? Directory.GetFiles(input).Order(StringComparer.Ordinal).ToArray() : [])
    {
        var lines = File.ReadAllLines(file).Select(line => line.ToUpperInvariant()).ToList();
        if (dropLastLine && lines.Count > 0) lines.RemoveAt(lines.Count - 1);
        var name = Path.GetFileName(file);
        Directory.CreateDirectory(output);
        File.WriteAllText(Path.Combine(output, $"{name}.out.txt"), string.Join("\n", lines) + "\n");
        if (eventSource is not null) WriteEvent(eventSource, $"finished {name} at {DateTime.UtcNow:O} in pid {Environment.ProcessId}");
        File.Delete(file);
        if (doneFile is not null) File.WriteAllText(Path.Combine(output, doneFile), "done\n");
    }
    await Task.Delay(50);
}

static void WriteEvent(string source, string message)
{
    var info = new ProcessStartInfo("eventcreate.exe") { UseShellExecute = false, RedirectStandardOutput = true };
    foreach (var argument in new[] { "/L", "APPLICATION", "/T", "INFORMATION", "/SO", source, "/ID", "100", "/D", message }) info.ArgumentList.Add(argument);
    using var process = Process.Start(info)!;
    process.StandardOutput.ReadToEnd();
    process.WaitForExit();
}
