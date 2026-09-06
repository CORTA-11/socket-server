---
status: superseded by ADR-0005
---

# Document connections expire for reauthorization

Document access is authorized with a document-scoped ticket, and the Hocuspocus service requests a refreshed token over the existing connection at least every five minutes. A failed refresh closes the Editing Session, bounding continued access after team membership removal without repeatedly disconnecting authorized Editors. Immediate revocation was rejected for the first release as additional coordination cost, while unbounded connections were rejected because they violate the current-member boundary.
