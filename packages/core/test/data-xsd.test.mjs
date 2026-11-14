// XML and SOAP data from XSD: the same recipe as JSON, with xs:pattern respected, and negatives only XML can have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkQuotas, compare, loadCases, loadManifest, loadRecipe, makeData, makeRows, parseXml, planRecipe, readXsd, run, soapEnvelope, soapHeaders, validateXml, writeCases, xsdPattern } from "../dist/index.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "dist", "main.js");
const NS = "urn:shop:orders";
const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" targetNamespace="${NS}" elementFormDefault="qualified">
  <xs:simpleType name="Phone"><xs:restriction base="xs:string"><xs:pattern value="\\+\\d+-\\d+"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="Money"><xs:restriction base="xs:decimal"><xs:minInclusive value="0"/><xs:maxInclusive value="999.99"/><xs:totalDigits value="5"/><xs:fractionDigits value="2"/></xs:restriction></xs:simpleType>
  <xs:complexType name="Line">
    <xs:sequence>
      <xs:element name="Sku" type="tns:Sku"/>
      <xs:element name="Qty"><xs:simpleType><xs:restriction base="xs:int"><xs:minInclusive value="1"/><xs:maxExclusive value="100"/></xs:restriction></xs:simpleType></xs:element>
    </xs:sequence>
  </xs:complexType>
  <xs:simpleType name="Sku"><xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}-\\d{4}"/><xs:maxLength value="8"/></xs:restriction></xs:simpleType>
  <xs:element name="Order">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Customer"><xs:simpleType><xs:restriction base="xs:string"><xs:minLength value="2"/><xs:maxLength value="10"/></xs:restriction></xs:simpleType></xs:element>
        <xs:element name="Phone" type="tns:Phone"/>
        <xs:element name="Kind"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="Retail"/><xs:enumeration value="Trade"/></xs:restriction></xs:simpleType></xs:element>
        <xs:element name="Total" type="tns:Money"/>
        <xs:element name="When" type="xs:date"/>
        <xs:element name="Note" type="xs:string" minOccurs="0"/>
        <xs:choice>
          <xs:element name="Card" type="xs:string"/>
          <xs:element name="Invoice" type="xs:int"/>
        </xs:choice>
        <xs:element name="Line" type="tns:Line" minOccurs="1" maxOccurs="3"/>
      </xs:sequence>
      <xs:attribute name="id" use="required"><xs:simpleType><xs:restriction base="xs:string"><xs:length value="4"/></xs:restriction></xs:simpleType></xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
const WSDL = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:billing" xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:billing">
  <wsdl:types><s:schema targetNamespace="urn:billing" elementFormDefault="qualified">
    <s:element name="GetInvoice"><s:complexType><s:sequence><s:element name="Number"><s:simpleType><s:restriction base="s:string"><s:pattern value="INV-\\d{4}"/></s:restriction></s:simpleType></s:element></s:sequence></s:complexType></s:element>
  </s:schema></wsdl:types>
  <wsdl:message name="In"><wsdl:part name="p" element="tns:GetInvoice"/></wsdl:message>
  <wsdl:portType name="Billing"><wsdl:operation name="GetInvoice"><wsdl:input message="tns:In"/></wsdl:operation></wsdl:portType>
  <wsdl:binding name="B" type="tns:Billing"><wsdl:operation name="GetInvoice"><soap:operation soapAction="urn:billing/GetInvoice"/></wsdl:operation></wsdl:binding>
</wsdl:definitions>`;

function project(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-xsd-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  legacy: { base_url: 'http://127.0.0.1:9' }\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.writeFileSync(path.join(dir, "order.xsd"), XSD);
    fs.writeFileSync(path.join(dir, "billing.wsdl"), WSDL);
    for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}

test("XSD to the model: elements, cardinality, facets, a named pattern, attributes and choices", () => {
    const p = project();
    const { recipe } = planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const f = (x) => recipe.fields.find((r) => r.path === x);
    assert.equal(recipe.source.format, "xsd");
    assert.equal(recipe.source.operation, "Order");
    assert.deepEqual(f("$.Order.Customer").constraints, { minLength: 2, maxLength: 10 });
    assert.equal(f("$.Order.Phone").constraints.pattern, "^(?:\\+\\d+-\\d+)$");
    assert.deepEqual(f("$.Order.Kind").constraints.enum, ["Retail", "Trade"]);
    const t = f("$.Order.Total").constraints;
    assert.equal(t.minimum, 0); assert.equal(t.maximum, 999.99); assert.equal(t.totalDigits, 5); assert.equal(t.fractionDigits, 2); assert.equal(t.multipleOf, 0.01);
    assert.equal(f("$.Order.When").constraints.format, "date");
    assert.equal(f("$.Order.Note").required, false);
    assert.equal(f("$.Order.Line").type, "array");
    assert.deepEqual([f("$.Order.Line").constraints.minItems, f("$.Order.Line").constraints.maxItems], [1, 3]);
    assert.equal(f("$.Order.Line[*].Qty").constraints.maximum, 100);
    assert.equal(f("$.Order.Line[*].Qty").type, "integer");
    assert.deepEqual(f("$.Order.@id").constraints, { minLength: 4, maxLength: 4 });
    assert.equal(f("$.Order.Invoice").required, false);
    assert.deepEqual(checkQuotas(recipe), []);
});

test("every row's XML is read back and agrees with the row: valid rows validate, invalid ones break where they say", () => {
    const p = project();
    planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const { recipe } = loadRecipe(p.m(), "order");
    const rows = makeRows(p.m(), recipe);
    const model = readXsd(path.join(p.dir, "order.xsd"));
    for (const r of rows) {
        const v = validateXml(model, r.xml);
        if (r.expect_valid) assert.deepEqual(v, [], `${r.name}: ${r.xml}`);
        else assert.ok(v.some((x) => x.path === r.invalid_because.path), `${r.name}: ${JSON.stringify(v)} ${r.xml}`);
        assert.equal(parseXml(r.xml).ns, r.name === "root_wrong_namespace" ? "urn:cmtk:not-this-namespace" : NS, r.name);
    }
    assert.ok(rows.filter((r) => r.expect_valid).length > 10);
    assert.ok(rows.filter((r) => !r.expect_valid).length > 20);
});

test("xs:pattern is respected: generated values match, and a value that breaks it is a row", () => {
    const p = project();
    const { recipe } = planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const rows = makeRows(p.m(), recipe);
    const base = rows.find((r) => r.name === "baseline_valid");
    assert.match(base.value.Order.Phone, /^\+\d+-\d+$/);
    assert.match(base.value.Order.Line[0].Sku, /^[A-Z]{3}-\d{4}$/);
    assert.ok(recipe.rows.find((r) => r.name === "Order_Phone_breaks_pattern" && r.invalid_because.keyword === "pattern"));
    assert.equal(xsdPattern("\\i\\c*"), "^(?:[A-Za-z_:][-A-Za-z0-9._:]*)$");
    assert.equal(xsdPattern("a\\-b"), "^(?:a\\x2db)$");
});

test("negatives only XML can have: a missing element, a wrong order, an extra element, twice, two branches, the wrong namespace", () => {
    const p = project();
    const { recipe } = planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const rows = makeRows(p.m(), recipe);
    const model = readXsd(path.join(p.dir, "order.xsd"));
    const v = (n) => { const r = rows.find((x) => x.name === n); assert.ok(r, n); assert.equal(r.expect_valid, false, n); return { r, kinds: validateXml(model, r.xml).map((x) => x.keyword) }; };
    assert.ok(v("Order_Customer_missing").kinds.includes("required"));
    const order = v("Order_wrong_order");
    assert.ok(order.kinds.includes("order"));
    assert.ok(order.r.xml.indexOf("<Phone") < order.r.xml.indexOf("<Customer"));
    assert.ok(v("Order_extra_element").kinds.includes("additional"));
    assert.match(v("Order_extra_element").r.xml, /<NotInTheSchema>/);
    assert.ok(v("Order_Customer_twice").kinds.includes("maxOccurs"));
    assert.ok(v("Order_Invoice_choice_two_branches").kinds.includes("choice"));
    assert.ok(v("root_wrong_namespace").kinds.includes("namespace"));
    assert.ok(v("Order_Line_each_extra_element").kinds.includes("additional"));
    assert.ok(v("Order_Line_maxItems_above_3bva").kinds.includes("maxItems"));
    assert.ok(v("Order_Line_each_Qty_maximum_above_3bva").kinds.includes("exclusiveMaximum"));
    const branch = rows.find((r) => r.name === "Order_Invoice_choice_branch");
    assert.equal(branch.expect_valid, true);
    assert.match(branch.xml, /<Invoice>/);
    assert.doesNotMatch(branch.xml, /<Card>/);
});

test("boundaries work on facets, and rows that mean nothing in XML are left out and said so", () => {
    const p = project();
    const { recipe } = planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const names = recipe.rows.map((r) => r.name);
    for (const n of ["Order_Customer_minLength_below_3bva", "Order_Customer_maxLength_above_3bva", "Order_Total_maximum_above_3bva", "Order_Total_minimum_below_3bva"]) assert.ok(names.includes(n), n);
    assert.ok(!names.includes("Order_Note_wrong_type"), "12345 is good text");
    assert.ok(!names.includes("body_not_an_object"));
    assert.ok(recipe.notes.some((n) => /mean nothing in XML/.test(n)));
    assert.match(recipe.fields.find((f) => f.path === "$.Order.Note").cannot_break, /every value is text/);
    const model = readXsd(path.join(p.dir, "order.xsd"));
    const r = makeRows(p.m(), recipe).find((x) => x.name === "Order_Customer_hostile_html");
    assert.ok(!r || r.expect_valid === false || validateXml(model, r.xml).length === 0, "escaped, and well-formed");
});

test("hostile text is escaped, so a row stays well-formed and says what it means", () => {
    const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="A"><xs:complexType><xs:sequence><xs:element name="T" type="xs:string"/></xs:sequence><xs:attribute name="at" type="xs:string"/></xs:complexType></xs:element></xs:schema>`;
    const p = project({ "a.xsd": xsd });
    const { recipe } = planRecipe(p.m(), { schema: "a.xsd", id: "a", seed: 1 });
    const rows = makeRows(p.m(), recipe);
    const h = rows.find((r) => r.name === "A_T_hostile_html");
    assert.match(h.xml, /&lt;script&gt;/);
    assert.equal(parseXml(h.xml).children[0].texts[0], "<script>alert(1)</script>");
    const no = rows.find((r) => r.name === "baseline_valid");
    assert.doesNotMatch(no.xml, /xmlns/, "no namespace in the schema: none in the document");
});

test("the same recipe gives the same documents", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "order.xsd", id: "order", seed: 5 });
    const a = await makeData(p.m(), "order", { formats: ["xml"], now: "2026-01-01T00:00:00Z" });
    const b = await makeData(p.m(), "order", { formats: ["xml"], now: "2030-01-01T00:00:00Z" });
    assert.deepEqual(a.manifest.files, b.manifest.files);
    const text = fs.readFileSync(path.join(p.dir, "cmtk", "data", "order", "rows", "baseline_valid.xml"), "utf8");
    assert.ok(text.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<Order xmlns="urn:shop:orders"'));
});

test("the SOAP envelope writer, 1.1 and 1.2", () => {
    const e = soapEnvelope("<A/>", "1.1");
    const n = parseXml(e);
    assert.equal(n.local, "Envelope");
    assert.equal(n.ns, "http://schemas.xmlsoap.org/soap/envelope/");
    assert.equal(n.children[0].local, "Body");
    assert.equal(parseXml(soapEnvelope("<A/>", "1.2")).ns, "http://www.w3.org/2003/05/soap-envelope");
    assert.deepEqual(soapHeaders({ version: "1.1", action: "urn:x" }), { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"urn:x"' });
    assert.deepEqual(soapHeaders({ version: "1.2", action: "urn:x" }), { "Content-Type": 'application/soap+xml; charset=utf-8; action="urn:x"' });
});

test("a WSDL: the operation's element, its action, and the operations listed when it's left out", () => {
    const p = project();
    assert.throws(() => planRecipe(p.m(), { schema: "billing.wsdl" }), /name the operation with --operation\. Operations: GetInvoice/);
    assert.throws(() => planRecipe(p.m(), { schema: "billing.wsdl", operation: "Nope" }), /no operation Nope/);
    const { recipe } = planRecipe(p.m(), { schema: "billing.wsdl", operation: "GetInvoice", id: "inv", seed: 2 });
    assert.deepEqual(recipe.soap, { version: "1.1", operation: "GetInvoice", action: "urn:billing/GetInvoice" });
    assert.ok(recipe.rows.some((r) => r.name === "GetInvoice_Number_breaks_pattern"));
});

test("what isn't understood is said, or refused: xs:union, xs:group, a remote import, an element not there", () => {
    const wrap = (b) => `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">${b}</xs:schema>`;
    const p = project({
        "u.xsd": wrap(`<xs:element name="A"><xs:simpleType><xs:union memberTypes="xs:int xs:date"/></xs:simpleType></xs:element>`),
        "g.xsd": wrap(`<xs:element name="A"><xs:complexType><xs:group ref="g"/></xs:complexType></xs:element>`),
        "i.xsd": wrap(`<xs:import schemaLocation="https://example.com/other.xsd"/><xs:element name="A" type="xs:string"/>`),
        "two.xsd": wrap(`<xs:element name="A" type="xs:string"/><xs:element name="B" type="xs:string"/>`),
        "r.xsd": wrap(`<xs:complexType name="T"><xs:sequence><xs:element name="Me" type="T"/></xs:sequence></xs:complexType><xs:element name="A" type="T"/>`),
        "bad.xsd": "<not xml",
    });
    assert.ok(planRecipe(p.m(), { schema: "u.xsd", id: "u" }).recipe.notes.some((n) => /xs:union and xs:list are not understood/.test(n)));
    assert.throws(() => planRecipe(p.m(), { schema: "g.xsd", id: "g" }), /xs:group is not supported/);
    assert.ok(planRecipe(p.m(), { schema: "i.xsd", id: "i" }).recipe.notes.some((n) => /only local files are followed/.test(n)));
    assert.throws(() => planRecipe(p.m(), { schema: "two.xsd", id: "t" }), /2 top-level elements/);
    assert.throws(() => planRecipe(p.m(), { schema: "two.xsd", operation: "C", id: "t" }), /no top-level element C/);
    assert.throws(() => planRecipe(p.m(), { schema: "r.xsd", id: "r" }), /requires itself/);
    assert.throws(() => planRecipe(p.m(), { schema: "bad.xsd", id: "b" }), /not XML/);
});

test("cases send the envelope with the right headers, and hold no expectation unless a person gave one", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "billing.wsdl", operation: "GetInvoice", id: "inv", seed: 2 });
    await makeData(p.m(), "inv", { now: "2026-01-01T00:00:00Z" });
    const { cases, withoutExpect } = writeCases(p.m(), "inv", { path: "/Billing.svc", requirement: "RULE-20" });
    assert.equal(withoutExpect, cases.length);
    for (const c of cases) {
        assert.equal(c.draft, true);
        assert.equal(c.expect, undefined);
        assert.equal(c.request.headers.SOAPAction, '"urn:billing/GetInvoice"');
        assert.equal(c.request.headers["Content-Type"], "text/xml; charset=utf-8");
        assert.match(c.request.body_file, /\.soap\.xml$/);
    }
    assert.throws(() => writeCases(p.m(), "inv", { path: "/x", out: "y.yaml", encoding: "form" }), /aren't sent as a form/);
});

// Two stand-in SOAP services on this machine: each checks the request's pattern itself, as a real one would.
function soapService(faultCode = "Client") {
    return new Promise((res) => {
        const s = http.createServer((q, r) => {
            let body = "";
            q.on("data", (d) => { body += d; });
            q.on("end", () => {
                const n = /<Number[^>]*>([^<]*)<\/Number>/.exec(body)?.[1];
                const ok = /^INV-\d{4}$/.test(n ?? "") && !/NotInTheSchema/.test(body) && (body.match(/<Number/g) ?? []).length === 1 && /<GetInvoice xmlns="urn:billing"/.test(body) && q.headers.soapaction === '"urn:billing/GetInvoice"';
                r.statusCode = ok ? 200 : 500;
                r.setHeader("content-type", "text/xml; charset=utf-8");
                r.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${ok ? `<GetInvoiceResponse xmlns="urn:billing"><Paid>true</Paid></GetInvoiceResponse>` : `<soap:Fault><faultcode>${faultCode}</faultcode><faultstring>rejected</faultstring></soap:Fault>`}</soap:Body></soap:Envelope>`);
            });
        });
        s.listen(0, "127.0.0.1", () => res(s));
    });
}

test("through the existing SOAP support: against two local services, valid rows pass, negatives fail, and a planted difference is caught", async () => {
    const [a, b, c] = await Promise.all([soapService(), soapService(), soapService("Server")]);
    try {
        const p = project();
        const url = (s) => `http://127.0.0.1:${s.address().port}`;
        const yaml = (cand) => `system: billing\nallow_unsafe_methods: true\ntargets:\n  legacy: { base_url: "${url(a)}" }\n  candidate: { base_url: "${url(cand)}" }\n`;
        fs.writeFileSync(path.join(p.dir, "cmtk.yaml"), yaml(b));
        planRecipe(p.m(), { schema: "billing.wsdl", operation: "GetInvoice", id: "inv", seed: 2 });
        await makeData(p.m(), "inv", { now: "2026-01-01T00:00:00Z" });
        // The statuses are given here as a person would give them: the rows themselves carry none.
        writeCases(p.m(), "inv", { path: "/Billing.svc", requirement: "RULE-20", expectValid: 200, expectInvalid: 500 });
        const f = path.join(p.dir, "cmtk", "cases", "data-inv.yaml");
        fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^\s*draft: true\n/gm, ""));
        assert.ok(loadCases(p.m()).every((x) => !x.draft));
        const ran = await run(p.m(), { target: "candidate", allowUnsafe: true, date: "2026-11-04" });
        assert.equal(ran.verdict, "PASS", JSON.stringify(ran.cases.filter((x) => x.result !== "PASS").slice(0, 3).map((x) => [x.name, x.failures])));
        const same = await compare(p.m(), { allowUnsafe: true, date: "2026-11-04" });
        assert.equal(same.verdict, "PARITY");
        fs.writeFileSync(path.join(p.dir, "cmtk.yaml"), yaml(c));
        const diff = await compare(p.m(), { allowUnsafe: true, date: "2026-11-04" });
        assert.equal(diff.verdict, "NO PARITY");
        const hit = diff.cases.find((x) => x.result === "DIFFERENT");
        assert.ok(hit.differences.some((d) => /faultcode/.test(d.where)));
    } finally { a.close(); b.close(); c.close(); }
});

test("the real command: cmtk data plan on a WSDL, make, and cases", () => {
    const p = project();
    const cmtk = (...a) => spawnSync(process.execPath, [CLI, "data", ...a], { cwd: p.dir, encoding: "utf8" });
    let r = cmtk("plan", "--schema", "billing.wsdl", "--operation", "GetInvoice", "--id", "inv");
    assert.equal(r.status, 0, r.stderr);
    r = cmtk("make", "inv");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(p.dir, "cmtk", "data", "inv", "rows", "baseline_valid.soap.xml")));
    r = cmtk("plan", "--schema", "order.xsd", "--id", "o2", "--soap", "1.2", "--soap-action", "urn:o");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadRecipe(p.m(), "o2").recipe.soap.version, "1.2");
    r = cmtk("plan", "--schema", "order.xsd", "--id", "o3", "--soap", "9");
    assert.equal(r.status, 3);
    r = cmtk("cases", "inv", "--path", "/Billing.svc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no expect: block yet/);
});
