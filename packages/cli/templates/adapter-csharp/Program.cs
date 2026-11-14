// The protocol: one JSON request per line on stdin, one JSON reply per line on stdout. Your code goes
// in Adapter.cs. Here, Console.WriteLine goes to stderr, so a stray line cannot break the protocol,
// and no header value can leave: a reply holding one becomes an error, and stderr hides it.
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
using var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
using var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
var secrets = new HashSet<string>();
var stderr = new HidingWriter(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true, NewLine = "\n" }, secrets);
Console.SetError(stderr);
Console.SetOut(stderr);
AppDomain.CurrentDomain.ProcessExit += (_, _) => Adapter.Close();

while (await stdin.ReadLineAsync() is { } line)
{
    var headers = new Dictionary<string, string>();
    JsonObject reply;
    try
    {
        var message = JsonNode.Parse(line) as JsonObject ?? throw new InvalidDataException("the request is not a JSON object");
        if (message["headers"] is JsonObject given)
        {
            foreach (var (header, value) in given)
            {
                headers[header] = value?.GetValue<string>() ?? "";
                if (headers[header].Length > 0) secrets.Add(headers[header]);
            }
        }
        var target = message["target"] as JsonObject ?? new JsonObject();
        var op = message["op"]?.GetValue<string>();
        reply = op switch
        {
            "describe" => Adapter.Describe(),
            "run" => await Adapter.Run(message["case"] as JsonObject ?? new JsonObject(), target, headers),
            "reset" => await Adapter.Reset(target),
            _ => new JsonObject { ["error"] = $"unknown op {op}" },
        };
    }
    catch (Exception err)
    {
        reply = new JsonObject { ["error"] = $"{err.GetType().Name}: {err.Message}" };
    }
    stdout.WriteLine(Checked(reply.ToJsonString(), headers));
}

// A reply that holds a header value is never sent. The error names the header, not its value.
static string Checked(string text, Dictionary<string, string> headers)
{
    foreach (var (header, value) in headers)
    {
        if (value.Length > 0 && text.Contains(JsonEncodedText.Encode(value).ToString()))
        {
            return new JsonObject { ["error"] = $"the adapter's reply held the value of the header {header}, so it was not sent" }.ToJsonString();
        }
    }
    return text;
}

/// <summary>Diagnostics go to stderr, with any header value hidden.</summary>
sealed class HidingWriter(TextWriter inner, HashSet<string> secrets) : TextWriter
{
    public override Encoding Encoding => inner.Encoding;
    public override void Write(char value) => inner.Write(value);
    public override void Write(string? value) => inner.Write(Hide(value));
    public override void WriteLine(string? value) => inner.WriteLine(Hide(value));
    string? Hide(string? text)
    {
        foreach (var secret in secrets) text = text?.Replace(secret, "[hidden]");
        return text;
    }
}
