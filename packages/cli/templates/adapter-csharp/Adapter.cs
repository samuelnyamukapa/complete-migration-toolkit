// A Complete Migration Toolkit adapter. Write what this boundary needs here: publish a message and
// read the queue, drop a file and read the output folder, query a mailbox, call a payment sandbox.
// Program.cs speaks the protocol, so you should not need to change it.
// Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit/blob/main/docs/ADAPTERS.md
using System.Text.Json.Nodes;

public static class Adapter
{
    const string Name = "__NAME__";

    /// <summary>What this adapter covers and the settings it needs.</summary>
    public static JsonObject Describe() => new()
    {
        ["name"] = Name,
        ["kinds"] = new JsonArray(Name),
        ["settings"] = new JsonArray(),
    };

    /// <summary>
    /// Run one case against one target and return an observation:
    ///   { status?, headers?, body?, effects?, error? }
    /// `effects` holds side effects as plain JSON (messages, rows, files, emails). The toolkit
    /// compares it between systems and checks it against expectations, exactly like a JSON body.
    /// `headers` holds credentials: use them, but never report or print them.
    /// GET, HEAD and OPTIONS must only observe. Leave out what changes on every run, such as ids and times.
    /// </summary>
    public static Task<JsonObject> Run(JsonObject testCase, JsonObject target, IReadOnlyDictionary<string, string> headers)
    {
        // Example only: echo what would be sent. Replace with the real interaction.
        var names = new JsonArray();
        foreach (var header in headers.Keys.Order(StringComparer.Ordinal)) names.Add(header);
        return Task.FromResult(new JsonObject
        {
            ["status"] = 200,
            ["effects"] = new JsonObject
            {
                ["target"] = target["name"]?.GetValue<string>(),
                ["method"] = testCase["request"]?["method"]?.GetValue<string>(),
                ["path"] = testCase["request"]?["path"]?.GetValue<string>(),
                ["headerNames"] = names,
            },
        });
    }

    /// <summary>Put a target back into the state every case starts from.</summary>
    public static Task<JsonObject> Reset(JsonObject target) => Task.FromResult(new JsonObject { ["ok"] = true });

    /// <summary>The run is over: stop anything this adapter started.</summary>
    public static void Close() { }
}
