---
status: accepted
---

# Start with one Hocuspocus replica

The first collaborative-editor release runs one self-hosted Hocuspocus replica. Editors obtain short-lived document-scoped tickets from the core API, and Hocuspocus validates a ticket when its Editing Session connects. The service uses standard Yjs synchronization, Presence, persistence hooks, and reconnect behavior; Redis coordination, custom durability messages, continuous token renewal, and multi-replica failover are deferred until demonstrated load or availability needs justify them.
