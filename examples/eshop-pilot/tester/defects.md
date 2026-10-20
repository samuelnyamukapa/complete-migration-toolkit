# Defect log: eshop-legacy

## D-01: Item details error pages reveal the server's physical path

- Date: 2026-10-20
- Status: Open
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
