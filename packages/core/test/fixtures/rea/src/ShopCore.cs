// The rebuild: the same public surface after a namespace move, plus a private helper of its own and one added method.
using System.Collections.Generic;

namespace ShopCore.Models {
    public class Item { public int Id { get; set; } public string Name { get; set; } public decimal Price; }
}

namespace ShopCore.Services {
    public interface ICatalogService {
        ShopCore.Models.Item FindItem(int id);
        IList<ShopCore.Models.Item> Search(string text, int page);
        void Remove(ShopCore.Models.Item item);
    }
    public class CatalogService : ICatalogService {
        public ShopCore.Models.Item FindItem(int id) { return Lookup(id); }
        public IList<ShopCore.Models.Item> Search(string text, int page) { return new List<ShopCore.Models.Item>(); }
        public void Remove(ShopCore.Models.Item item) { }
        private ShopCore.Models.Item Lookup(int id) { return new ShopCore.Models.Item(); }
    }
}
