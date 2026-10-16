// Reads one request path per line on stdin and writes one cmtk observation per line on stdout.
// Every request gets a new in-memory mock catalog, so cases never affect each other and nothing
// is stored anywhere.
//   /items?pageSize=10&pageIndex=0   GetCatalogItemsPaginated
//   /items/7                         FindCatalogItem
//   /brands  /types                  GetCatalogBrands, GetCatalogTypes
//   /validate?name=&price=&stock=&restock=&maxstock=&culture=   model validation (data annotations)
using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
#if NET472
using eShopLegacyMVC.Models;
using eShopLegacyMVC.Services;
#else
using CatalogCore.Models;
using CatalogCore.Services;
#endif

namespace CatalogProbe
{
    public static class Program
    {
        public static int Main()
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Console.Out.WriteLine(Answer(line.Trim()));
                Console.Out.Flush();
            }
            return 0;
        }

        static string Answer(string pathAndQuery)
        {
            var culture = Thread.CurrentThread.CurrentCulture;
            var uiCulture = Thread.CurrentThread.CurrentUICulture;
            try
            {
                var q = pathAndQuery.IndexOf('?');
                var path = q < 0 ? pathAndQuery : pathAndQuery.Substring(0, q);
                var query = Parse(q < 0 ? "" : pathAndQuery.Substring(q + 1));
                var service = new CatalogServiceMock();
                if (path == "/items")
                {
                    var page = service.GetCatalogItemsPaginated(Int(query, "pageSize"), Int(query, "pageIndex"));
                    var j = new Json().Begin()
                        .Field("ActualPage").Num(page.ActualPage)
                        .Field("ItemsPerPage").Num(page.ItemsPerPage)
                        .Field("TotalItems").Num(page.TotalItems)
                        .Field("TotalPages").Num(page.TotalPages)
                        .Field("Data").BeginArray();
                    foreach (var item in page.Data) Item(j, item);
                    return Ok(j.EndArray().End().ToString());
                }
                if (path.StartsWith("/items/"))
                {
                    var item = service.FindCatalogItem(int.Parse(path.Substring(7), CultureInfo.InvariantCulture));
                    var j = new Json();
                    if (item == null) j.Null(); else Item(j, item);
                    return Ok(j.ToString());
                }
                if (path == "/brands")
                {
                    var j = new Json().BeginArray();
                    foreach (var b in service.GetCatalogBrands()) j.Begin().Field("Id").Num(b.Id).Field("Brand").Str(b.Brand).End();
                    return Ok(j.EndArray().ToString());
                }
                if (path == "/types")
                {
                    var j = new Json().BeginArray();
                    foreach (var t in service.GetCatalogTypes()) j.Begin().Field("Id").Num(t.Id).Field("Type").Str(t.Type).End();
                    return Ok(j.EndArray().ToString());
                }
                if (path == "/validate")
                {
                    string c;
                    if (query.TryGetValue("culture", out c))
                    {
                        Thread.CurrentThread.CurrentCulture = new CultureInfo(c);
                        Thread.CurrentThread.CurrentUICulture = new CultureInfo(c);
                    }
                    string name;
                    query.TryGetValue("name", out name);
                    var item = new CatalogItem
                    {
                        Name = name,
                        Price = Dec(query, "price"),
                        AvailableStock = IntOr(query, "stock", 0),
                        RestockThreshold = IntOr(query, "restock", 0),
                        MaxStockThreshold = IntOr(query, "maxstock", 0),
                    };
                    var results = new List<ValidationResult>();
                    var valid = Validator.TryValidateObject(item, new ValidationContext(item, null, null), results, true);
                    var j = new Json().Begin().Field("Valid").Bool(valid).Field("Errors").BeginArray();
                    foreach (var r in results.OrderBy(r => string.Join(",", r.MemberNames), StringComparer.Ordinal).ThenBy(r => r.ErrorMessage, StringComparer.Ordinal))
                    {
                        j.Begin().Field("Members").BeginArray();
                        foreach (var m in r.MemberNames) j.Str(m);
                        j.EndArray().Field("Message").Str(r.ErrorMessage).End();
                    }
                    return Ok(j.EndArray().End().ToString());
                }
                return Answer(404, new Json().Begin().Field("error").Str("unknown operation " + path).End().ToString());
            }
            catch (Exception e)
            {
                // A service exception is part of its behaviour: report its type and message.
                return Answer(500, new Json().Begin().Field("exception").Str(e.GetType().FullName).Field("message").Str(e.Message).End().ToString());
            }
            finally
            {
                Thread.CurrentThread.CurrentCulture = culture;
                Thread.CurrentThread.CurrentUICulture = uiCulture;
            }
        }

        static void Item(Json j, CatalogItem i)
        {
            j.Begin()
                .Field("Id").Num(i.Id).Field("Name").Str(i.Name).Field("Description").Str(i.Description)
                .Field("Price").Raw(i.Price.ToString(CultureInfo.InvariantCulture))
                .Field("PictureFileName").Str(i.PictureFileName).Field("PictureUri").Str(i.PictureUri)
                .Field("CatalogTypeId").Num(i.CatalogTypeId).Field("CatalogType");
            if (i.CatalogType == null) j.Null(); else j.Begin().Field("Id").Num(i.CatalogType.Id).Field("Type").Str(i.CatalogType.Type).End();
            j.Field("CatalogBrandId").Num(i.CatalogBrandId).Field("CatalogBrand");
            if (i.CatalogBrand == null) j.Null(); else j.Begin().Field("Id").Num(i.CatalogBrand.Id).Field("Brand").Str(i.CatalogBrand.Brand).End();
            j.Field("AvailableStock").Num(i.AvailableStock).Field("RestockThreshold").Num(i.RestockThreshold)
                .Field("MaxStockThreshold").Num(i.MaxStockThreshold).Field("OnReorder").Bool(i.OnReorder).End();
        }

        static string Ok(string body) => Answer(200, body);

        static string Answer(int status, string body) =>
            "{\"status\":" + status + ",\"headers\":{\"content-type\":\"application/json\"},\"body\":" + Json.Quote(body) + "}";

        static Dictionary<string, string> Parse(string query)
        {
            var d = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in query.Split(new[] { '&' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = part.IndexOf('=');
                var k = Uri.UnescapeDataString((eq < 0 ? part : part.Substring(0, eq)).Replace('+', ' '));
                d[k] = eq < 0 ? "" : Uri.UnescapeDataString(part.Substring(eq + 1).Replace('+', ' '));
            }
            return d;
        }

        static int Int(Dictionary<string, string> q, string k)
        {
            string v;
            if (!q.TryGetValue(k, out v)) throw new ArgumentException(k + " is required");
            return int.Parse(v, NumberStyles.Integer, CultureInfo.InvariantCulture);
        }

        static int IntOr(Dictionary<string, string> q, string k, int fallback) => q.ContainsKey(k) ? Int(q, k) : fallback;

        static decimal Dec(Dictionary<string, string> q, string k)
        {
            string v;
            return q.TryGetValue(k, out v) ? decimal.Parse(v, NumberStyles.Number, CultureInfo.InvariantCulture) : 0m;
        }
    }

    /// <summary>Writes JSON by hand, so both runtimes produce the same bytes.</summary>
    sealed class Json
    {
        readonly StringBuilder sb = new StringBuilder();
        bool needComma;

        void Sep() { if (needComma) sb.Append(','); needComma = false; }
        public Json Begin() { Sep(); sb.Append('{'); return this; }
        public Json End() { sb.Append('}'); needComma = true; return this; }
        public Json BeginArray() { Sep(); sb.Append('['); return this; }
        public Json EndArray() { sb.Append(']'); needComma = true; return this; }
        public Json Field(string name) { Sep(); sb.Append(Quote(name)).Append(':'); return this; }
        public Json Str(string v) { Sep(); sb.Append(v == null ? "null" : Quote(v)); needComma = true; return this; }
        public Json Num(long v) { Sep(); sb.Append(v.ToString(CultureInfo.InvariantCulture)); needComma = true; return this; }
        public Json Raw(string v) { Sep(); sb.Append(v); needComma = true; return this; }
        public Json Bool(bool v) { Sep(); sb.Append(v ? "true" : "false"); needComma = true; return this; }
        public Json Null() { Sep(); sb.Append("null"); needComma = true; return this; }
        public override string ToString() => sb.ToString();

        public static string Quote(string s)
        {
            var b = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else b.Append(c);
                        break;
                }
            }
            return b.Append('"').ToString();
        }
    }
}
