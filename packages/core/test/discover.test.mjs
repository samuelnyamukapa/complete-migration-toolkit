// cmtk discover: every boundary of the legacy system, where it was found, and whether an adapter covers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { check, discover, loadManifest } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-disc-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};

// The shape of `rea inspect-managed-members <dll> --json`, cut down to what discover reads.
const REA = {
    subject: { name: "Shop.dll" },
    normalized_result: {
        methods: [
            { token: "0x06000001", declaring_type: "Shop.Controllers.HomeController" },
            { token: "0x06000002", declaring_type: "Shop.Api.OrdersController" },
            { token: "0x06000003", declaring_type: "Shop.Data.ShopContext" },
            { token: "0x06000004", declaring_type: "Shop.Mail.Notifier" },
            { token: "0x06000005", declaring_type: "<>c" },
        ],
        call_edges: [
            { caller_token: "0x06000001", target_declaring_type: "System.Web.Mvc.Controller" },
            { caller_token: "0x06000002", target_declaring_type: "System.Web.Http.ApiController" },
            { caller_token: "0x06000003", target_declaring_type: "System.Data.Entity.DbContext" },
            { caller_token: "0x06000004", target_declaring_type: "System.Net.Mail.SmtpClient" },
            { caller_token: "0x06000004", target_declaring_type: "System.Net.Http.HttpClient" },
            { caller_token: "0x06000005", target_declaring_type: "System.IO.File" },
            { caller_token: "0x06000001", target_declaring_type: "System.String" },
        ],
    },
};
const WEB_CONFIG = `<?xml version="1.0"?>
<configuration>
  <connectionStrings>
    <add name="ShopContext" connectionString="Data Source=sql01;Initial Catalog=Shop;User ID=app;Password=hunter2!" providerName="System.Data.SqlClient" />
  </connectionStrings>
  <appSettings>
    <add key="PaymentsUrl" value="https://user:pw@pay.example.com/v1/charge" />
    <add key="OrdersQueue" value="FormatName:DIRECT=OS:.\\private$\\orders" />
    <add key="Theme" value="blue" />
  </appSettings>
  <system.net><mailSettings><smtp from="shop@example.com"><network host="mail.example.com" password="smtp-secret" /></smtp></mailSettings></system.net>
</configuration>`;

function project(adapters = "") {
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: shop\ntargets:\n  legacy: { base_url: "http://localhost:4100" }\n${adapters}`);
    write(dir, "rea/Shop.json", JSON.stringify(REA));
    write(dir, "legacy/Web.config", WEB_CONFIG);
    write(dir, "legacy/appsettings.json", JSON.stringify({ ConnectionStrings: { Reports: "Host=db2;Database=reports;Username=u;Password=s3cret" }, Services: { Stock: "https://stock.example.com/api?key=abc123" } }));
    write(dir, "rec.har", JSON.stringify({ log: { entries: [
        { request: { method: "GET", url: "http://localhost:4100/catalog" } },
        { request: { method: "GET", url: "http://localhost:4100/catalog?page=2" } },
        { request: { method: "GET", url: "https://cdn.example.com/app.js" } },
    ] } }));
    write(dir, "analysis/topology.json", JSON.stringify({ root: { id: "sys", kind: "system", children: [{ id: "dom:data", kind: "domain", children: [{ id: "ds:CUSTFILE", name: "CUSTOMER-FILE", kind: "datastore" }, { id: "J1", name: "NIGHTLY", kind: "job" }] }] } }));
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}

test("discover lists every boundary from REA, settings, recordings and the map, and flags the uncovered ones", () => {
    const p = project("adapters:\n  mailbox: { command: node, args: [x.mjs], covers: [email] }\n");
    const { file, discovery } = discover(p.m(), {
        reaJson: ["rea/Shop.json"], configs: ["legacy/Web.config", "legacy/appsettings.json"], har: ["rec.har"], topology: ["analysis/topology.json"],
    }, "2026-10-20");
    const by = (name) => discovery.boundaries.find((b) => b.name === name);
    const md = fs.readFileSync(path.join(p.dir, file), "utf8");
    const json = fs.readFileSync(path.join(p.dir, "cmtk/discovery/boundaries.json"), "utf8");

    assert.equal(by("Shop.Controllers.HomeController").kind, "http");
    assert.equal(by("Shop.Controllers.HomeController").covered_by, "http (built in)");
    assert.match(by("Shop.Api.OrdersController").where, /^\/api\/orders /);
    assert.equal(by("ShopContext").where, "server sql01, database Shop");
    assert.match(by("ShopContext").found_in.map((f) => f.detail).join(" "), /used by Shop\.Data\.ShopContext/, "REA's database use is folded into the connection string of the same name");
    assert.ok(!discovery.boundaries.some((b) => b.name === "Shop.dll: database"));
    assert.equal(by("Reports").where, "server db2, database reports");
    assert.equal(by("PaymentsUrl").where, "https://pay.example.com");
    assert.equal(by("OrdersQueue").kind, "queue");
    assert.equal(by("smtp").where, "mail.example.com");
    assert.equal(by("smtp").covered_by, "mailbox", "an adapter's covers list covers that kind");
    assert.equal(by("Shop.dll: email").covered_by, "mailbox");
    assert.equal(by("Services:Stock").where, "https://stock.example.com");
    assert.equal(by("http://localhost:4100").kind, "http", "the system's own address, seen in the recording");
    assert.equal(by("https://cdn.example.com").kind, "outbound-http");
    assert.equal(by("CUSTOMER-FILE").kind, "files");
    assert.equal(by("NIGHTLY").kind, "worker");
    assert.ok(!discovery.boundaries.some((b) => /<>c/.test(JSON.stringify(b.found_in))), "compiler-made types are not listed as users");
    for (const secret of ["hunter2", "smtp-secret", "s3cret", "abc123", "user:pw", "User ID=app"]) {
        assert.ok(!md.includes(secret) && !json.includes(secret), `${secret} is never copied`);
    }
    assert.match(md, /\*\*uncovered\*\*/);
    assert.match(md, /- \*\*database\*\*: Reports, ShopContext/);
    assert.ok(discovery.boundaries.findIndex((b) => !b.covered_by) < discovery.boundaries.findIndex((b) => b.covered_by), "uncovered first");

    const c = check(p.m());
    assert.match(c.discovery, /boundaries: \d+ covered by an adapter, \d+ uncovered/);
    assert.ok(c.warnings.some((w) => /boundary ShopContext \(database\) is uncovered/.test(w)));
});

test("discover adds to the last inventory unless asked to start afresh, and takes an agent's findings only with evidence", () => {
    const p = project();
    discover(p.m(), { configs: ["legacy/Web.config"] }, "2026-10-20");
    const second = discover(p.m(), {
        found: [{ kind: "files", name: "Invoice export", where: "\\\\fs01\\exports", evidence: "src/Billing/Export.cs:40 writes the invoice CSV" }], agent: "agent: Copilot",
    }, "2026-10-20").discovery;
    assert.ok(second.boundaries.some((b) => b.name === "ShopContext"), "the earlier findings are kept");
    const exp = second.boundaries.find((b) => b.name === "Invoice export");
    assert.deepEqual(exp.found_in, [{ source: "agent: Copilot", detail: "src/Billing/Export.cs:40 writes the invoice CSV" }]);
    assert.equal(exp.direction, "out");
    assert.deepEqual(second.sources, ["legacy/Web.config", "findings from agent Copilot"]);

    assert.throws(() => discover(p.m(), { found: [{ kind: "files", name: "x", evidence: "seen" }] }), /agent's name is required/);
    assert.throws(() => discover(p.m(), { found: [{ kind: "files", name: "x" }], agent: "a" }), /evidence is required/);
    assert.throws(() => discover(p.m(), { found: [{ kind: "ftp", name: "x", evidence: "e" }], agent: "a" }), /kind must be one of/);
    assert.throws(() => discover(p.m(), { found: [{ kind: "files", name: "x‮evil", evidence: "e" }], agent: "a" }), /control characters/);
    assert.throws(() => discover(p.m(), {}), /Give discover something to read/);
    assert.throws(() => discover(p.m(), { configs: ["../outside.config"] }), /outside the project folder/);
    assert.throws(() => discover(p.m(), { reaJson: ["legacy/appsettings.json"] }), /not the output of `rea inspect-managed-members/);

    const fresh = discover(p.m(), { har: ["rec.har"], fresh: true }, "2026-10-20").discovery;
    assert.ok(!fresh.boundaries.some((b) => b.name === "ShopContext"));
});

test("discover runs REA on an assembly when it is installed, and says how to install it when it is not", () => {
    const p = project();
    write(p.dir, "legacy/bin/Shop.dll", "MZ");
    const fake = path.join(p.dir, "fake-rea.mjs");
    fs.writeFileSync(fake, `const a = process.argv.slice(2);\nif (a[0] !== "inspect-managed-members" || a[2] !== "--json") process.exit(9);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(REA))});\n`);
    const saved = process.env.CMTK_REA;
    try {
        process.env.CMTK_REA = fake;
        const d = discover(p.m(), { assemblies: ["legacy/bin/Shop.dll"] }, "2026-10-20").discovery;
        assert.ok(d.boundaries.some((b) => b.name === "Shop.Controllers.HomeController" && b.found_in[0].source === "REA: legacy/bin/Shop.dll"));
        process.env.CMTK_REA = path.join(p.dir, "no-such-rea");
        assert.throws(() => discover(p.m(), { assemblies: ["legacy/bin/Shop.dll"] }), /REA is not installed\. Install it with `npm install --global rea-agents`/);
    } finally {
        if (saved === undefined) delete process.env.CMTK_REA; else process.env.CMTK_REA = saved;
    }
    assert.throws(() => loadManifest((write(p.dir, "bad.yaml", "system: s\ntargets:\n  a: http://x\nadapters:\n  q: { command: node, covers: [ftp] }\n"), path.join(p.dir, "bad.yaml"))), /covers must be a list of boundary kinds/);
});
