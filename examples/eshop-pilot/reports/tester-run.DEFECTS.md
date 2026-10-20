# Draft defects: eshop-legacy

From `cmtk run` on 2026-10-20 (verdict FAIL). Each draft groups the cases that fail the same way.
A person checks each one and files it. Nothing here has been filed.

## D-01: body: expected never contains "Physical Path", got found: "></tr> \n    <tr><th>Physical Path</th><td>&nbsp;&nbsp;&nbsp;D:\\githubProj"

- Requirements: EXPLORE/X20261019-213230
- Cases: EXP-20261019213230-01
- Found by: `cmtk run` on 2026-10-20

### Steps to reproduce

1. Send `GET /Catalog/Details/2147483648` to candidate (http://localhost:53190).

### Expected

- `body`: never contains "Physical Path"

### Actual

- `body`: found: "></tr> \n    <tr><th>Physical Path</th><td>&nbsp;&nbsp;&nbsp;D:\\githubProj"

### Evidence

- `cmtk/evidence/run/answers/EXP-20261019213230-01.json`

## D-02: 2 checks fail, first body: expected never contains "System.Web.Mvc", got found: "IController.\r\n   at System.Web.Mvc.DefaultControllerFactory.GetControllerI"

- Requirements: EXPLORE/X20261019-213230
- Cases: EXP-20261019213230-02
- Found by: `cmtk run` on 2026-10-20

### Steps to reproduce

1. Send `GET /items/2147483648/pic` to candidate (http://localhost:53190).

### Expected

- `body`: never contains "System.Web.Mvc"
- `body`: never contains "HttpException"

### Actual

- `body`: found: "IController.\r\n   at System.Web.Mvc.DefaultControllerFactory.GetControllerI"
- `body`: found: ">\r\n</html>\r\n<!-- \r\n[HttpException]: The controller for path &#39;/items/2"

### Evidence

- `cmtk/evidence/run/answers/EXP-20261019213230-02.json`
