// Routes from [Route] attributes. REA 6.8.0 gives each attribute's length and sha256 but not its value; the
// recorded fixtures show that, and the source reader's result is proved against those digests.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeRouteValue, discover, encodeRouteValue, joinRoutes, loadManifest, readRoutesFromSource, sourceMatches, templateFromRea } from "../dist/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rea");
const text = (n) => fs.readFileSync(path.join(FIX, n), "utf8");
const artifact = () => JSON.parse(text("Shop.artifact.json"));
const routeAttrs = () => artifact().normalized_result.attributes.filter((a) => /Route/.test(a.type_name ?? ""));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function project(withArtifact = true, withSource = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-routes-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  legacy: { base_url: 'http://localhost:4100' }\n");
    fs.mkdirSync(path.join(dir, "rea"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.copyFileSync(path.join(FIX, "Shop.members.json"), path.join(dir, "rea", "members.json"));
    fs.copyFileSync(path.join(FIX, "Shop.artifact.json"), path.join(dir, "rea", "artifact.json"));
    fs.copyFileSync(path.join(FIX, "src", "Shop.cs"), path.join(dir, "src", "Shop.cs"));
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    const { discovery } = discover(m, { reaJson: ["rea/members.json", ...(withArtifact ? ["rea/artifact.json"] : [])], ...(withSource ? { routesFrom: ["src"] } : {}) }, "2026-11-04");
    return { dir, m, where: (name) => discovery.boundaries.find((b) => b.name === name)?.where, discovery };
}

test("what REA really gives: every route attribute has a length and a digest, and no value", () => {
    const attrs = routeAttrs();
    assert.equal(attrs.length, 5);
    for (const a of attrs) {
        assert.equal(a.decoded_fixed_string, null);
        assert.equal(a.value_hex, undefined);
        assert.equal(templateFromRea(a), undefined);
    }
});

test("the bytes of a route attribute are worked out exactly: REA's recorded digest agrees", () => {
    const b = encodeRouteValue("items/{id:int}/pic", [{ name: "Name", value: "GetPic" }]);
    const a = routeAttrs().find((x) => x.value_length === 37);
    assert.equal(b.length, 37);
    assert.equal(sha(b), a.value_sha256);
    assert.equal(decodeRouteValue(b), "items/{id:int}/pic");
    const plain = encodeRouteValue("api/v2/brands");
    assert.equal(sha(plain), routeAttrs().find((x) => /Http\.Route/.test(x.type_name)).value_sha256);
});

test("if REA gives the bytes or the string, they are used; bytes that don't match its digest are not believed", () => {
    const b = encodeRouteValue("x/y");
    assert.equal(templateFromRea({ value_hex: b.toString("hex"), value_sha256: sha(b) }), "x/y");
    assert.equal(templateFromRea({ value_base64: b.toString("base64"), value_sha256: sha(b) }), "x/y");
    assert.equal(templateFromRea({ value_hex: b.toString("hex"), value_sha256: "0".repeat(64) }), undefined);
    assert.equal(templateFromRea({ decoded_fixed_string: "a/b" }), "a/b");
    assert.equal(decodeRouteValue(Buffer.from([2, 0, 1, 65])), undefined);
    assert.equal(decodeRouteValue(Buffer.from([1, 0, 200])), undefined);
});

test("reading routes from C#: attributes on types and methods, named arguments, comments and strings ignored", () => {
    const got = readRoutesFromSource(`
namespace A.B;
// [Route("commented/out")]
/* [Route("also/out")] */
[Authorize, Route(@"v1/things", Order = 2)]
public class ThingsController : ControllerBase {
    private string s = "[Route(\\"in/a/string\\")]";
    [HttpGet("{id}", Name = "Get")] public async Task<IActionResult> Get(int id) { if (id > 0) { return Ok(); } return NotFound(); }
    [HttpPost] public IActionResult Add() => Ok();
    [Route(Constants.Path)] public int Odd() { return 1; }
}
public class NotOne { [Route("nope")] public void M() { } }
`, "T.cs");
    const t = got.find((x) => x.type === "A.B.ThingsController");
    assert.ok(t.controller);
    assert.deepEqual(t.on_type.map((r) => [r.attribute, r.template, r.named]), [["Route", "v1/things", [{ name: "Order", value: 2 }]]]);
    assert.equal(t.on_type[0].line, 5);
    assert.deepEqual(t.on_methods.map((m) => [m.method, m.routes[0].attribute, m.routes[0].template]), [["Get", "HttpGet", "{id}"], ["Add", "HttpPost", null], ["Odd", "Route", null]]);
    assert.equal(t.on_methods[2].routes[0].named, undefined, "a constant can't be read, and can't be proved");
    assert.equal(got.find((x) => x.type === "A.B.NotOne").controller, false);
});

test("reading routes from C#: block namespaces, nested namespaces and verbatim strings", () => {
    const got = readRoutesFromSource(`namespace X { namespace Y { [RoutePrefix("p")] public class Z : ApiController { [Route(@"a""b")] public void M() { } } } }`, "T.cs");
    assert.equal(got[0].type, "X.Y.Z");
    assert.equal(got[0].on_methods[0].routes[0].template, 'a"b');
});

test("joining: the type's route, then the method's, unless the method's is absolute", () => {
    assert.deepEqual(joinRoutes(["orders"], ["{id}/lines", "~/recent"]), ["/orders/{id}/lines", "/recent"]);
    assert.deepEqual(joinRoutes(["items/{id:int}/pic"], []), ["/items/{id:int}/pic"]);
    assert.deepEqual(joinRoutes(["a"], [null]), ["/a"]);
    assert.deepEqual(joinRoutes([], ["b", "/c"]), ["/b", "/c"]);
    assert.deepEqual(joinRoutes(["a"], ["/abs", null]), ["/a", "/abs"]);
});

test("with the source, the route is the real one and the assembly proves it: PicController is not /Pic", () => {
    const p = project(true, true);
    assert.equal(p.where("Shop.Controllers.PicController"), "/items/{id:int}/pic");
    assert.equal(p.where("Shop.Controllers.OrdersController"), "/orders/{id}/lines, /recent");
    assert.equal(p.where("Shop.Api.BrandsController"), "/api/v2/brands");
    const pic = p.discovery.boundaries.find((b) => b.name === "Shop.Controllers.PicController");
    assert.ok(pic.found_in.some((f) => /matching the assembly's attribute by sha256/.test(f.detail) && /src\/Shop\.cs:\d+/.test(f.detail)));
});

test("the naming guess stays only with no attribute", () => {
    const p = project(true, true);
    assert.equal(p.where("Shop.Controllers.HomeController"), "/Home (by naming convention; it has no [Route] attribute)");
});

test("without the source, a controller with an attribute says exactly what's missing, and never guesses", () => {
    const p = project(true, false);
    const w = p.where("Shop.Controllers.PicController");
    assert.match(w, /route attribute present, value not read/);
    assert.match(w, /--routes-from/);
    assert.match(w, /value_hex/);
    assert.doesNotMatch(w, /\/Pic\b/);
});

test("without REA's attribute output, the guess is marked as one", () => {
    const p = project(false, false);
    assert.match(p.where("Shop.Controllers.PicController"), /^\/Pic \(by naming convention; check the real route\)$/);
});

test("source that doesn't match the build says so, rather than reading as the route", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-routes-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  legacy: { base_url: 'http://localhost:4100' }\n");
    fs.copyFileSync(path.join(FIX, "Shop.members.json"), path.join(dir, "members.json"));
    fs.copyFileSync(path.join(FIX, "Shop.artifact.json"), path.join(dir, "artifact.json"));
    fs.writeFileSync(path.join(dir, "Old.cs"), text("src/Shop.cs").replace("items/{id:int}/pic", "items/{id}/picture"));
    const { discovery } = discover(loadManifest(path.join(dir, "cmtk.yaml")), { reaJson: ["members.json", "artifact.json"], routesFrom: ["Old.cs"] }, "2026-11-04");
    assert.match(discovery.boundaries.find((b) => b.name === "Shop.Controllers.PicController").where, /do not match it: is the source for this build\?/);
});

test("a controller only the source shows is listed, and says no build confirmed it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-routes-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  legacy: { base_url: 'http://localhost:4100' }\n");
    fs.writeFileSync(path.join(dir, "A.cs"), `namespace N { [Route("api/a")] public class AController : ControllerBase { } }`);
    const { discovery } = discover(loadManifest(path.join(dir, "cmtk.yaml")), { routesFrom: ["A.cs"] }, "2026-11-04");
    assert.equal(discovery.boundaries[0].where, "/api/a (from source; not checked against a build)");
    assert.throws(() => discover(loadManifest(path.join(dir, "cmtk.yaml")), { routesFrom: ["missing"] }), /does not exist/);
});
