// The rebuild with planted changes: FindItem takes a long, Remove is gone, and Count is new.
using System.Collections.Generic;

namespace ShopCore.Models {
    public class Item { public int Id { get; set; } public string Name { get; set; } public decimal Price; }
}

namespace ShopCore.Services {
    public interface ICatalogService {
        ShopCore.Models.Item FindItem(long id);
        IList<ShopCore.Models.Item> Search(string text, int page);
        int Count();
    }
    public class CatalogService : ICatalogService {
        public ShopCore.Models.Item FindItem(long id) { return new ShopCore.Models.Item(); }
        public IList<ShopCore.Models.Item> Search(string text, int page) { return new List<ShopCore.Models.Item>(); }
        public int Count() { return 0; }
    }
}
