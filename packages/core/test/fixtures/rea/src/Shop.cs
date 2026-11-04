// The legacy build of a small system: a service interface, its implementation, and controllers with routes.
using System.Collections.Generic;

namespace Shop.Models {
    public class Item { public int Id { get; set; } public string Name { get; set; } public decimal Price; }
}

namespace Shop.Services {
    public interface ICatalogService {
        Shop.Models.Item FindItem(int id);
        IList<Shop.Models.Item> Search(string text, int page);
        void Remove(Shop.Models.Item item);
    }
    public class CatalogService : ICatalogService {
        public Shop.Models.Item FindItem(int id) { return Helper(id); }
        public IList<Shop.Models.Item> Search(string text, int page) { return new List<Shop.Models.Item>(); }
        public void Remove(Shop.Models.Item item) { }
        private Shop.Models.Item Helper(int id) { return new Shop.Models.Item(); }
        internal void Audit() { }
    }
}

namespace Shop.Controllers {
    public class HomeController : System.Web.Mvc.Controller { public string Index() { return "x"; } }

    [System.Web.Mvc.Route("items/{id:int}/pic", Name = "GetPic")]
    public class PicController : System.Web.Mvc.Controller { public string Get(int id) { return "x"; } }

    [System.Web.Mvc.RoutePrefix("orders")]
    public class OrdersController : System.Web.Mvc.Controller {
        [System.Web.Mvc.Route("{id}/lines")] public string Lines(int id) { return "x"; }
        [System.Web.Mvc.Route("~/recent")] public string Recent() { return "x"; }
    }
}

namespace Shop.Api {
    [System.Web.Http.Route("api/v2/brands")]
    public class BrandsController : System.Web.Http.ApiController { public string Get() { return "x"; } }
}
