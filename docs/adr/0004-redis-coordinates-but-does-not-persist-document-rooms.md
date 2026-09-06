---
status: superseded by ADR-0005
---

# Redis coordinates but does not persist Document Rooms

Hocuspocus replicas use the Redis extension to synchronize Document updates and Presence and to coordinate which replica persists the current state. Redis remains transient coordination infrastructure: complete canonical Yjs state is loaded from and stored through private core API endpoints, so replica placement and Redis loss do not redefine document authority.
