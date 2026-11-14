// Stand-ins for the framework's types, so `mcs` needs no System.Web reference. Same names, same shapes.
namespace System.Web.Mvc {
    public abstract class Controller { protected Controller() { } }
    [System.AttributeUsage(System.AttributeTargets.Class | System.AttributeTargets.Method, AllowMultiple = true)]
    public sealed class RouteAttribute : System.Attribute { public RouteAttribute(string template) { Template = template; } public string Template { get; private set; } public string Name { get; set; } public int Order { get; set; } }
    [System.AttributeUsage(System.AttributeTargets.Class)]
    public sealed class RoutePrefixAttribute : System.Attribute { public RoutePrefixAttribute(string prefix) { Prefix = prefix; } public string Prefix { get; private set; } }
}
namespace System.Web.Http {
    public abstract class ApiController { protected ApiController() { } }
    [System.AttributeUsage(System.AttributeTargets.Class | System.AttributeTargets.Method, AllowMultiple = true)]
    public sealed class RouteAttribute : System.Attribute { public RouteAttribute(string template) { Template = template; } public string Template { get; private set; } public string Name { get; set; } }
}
