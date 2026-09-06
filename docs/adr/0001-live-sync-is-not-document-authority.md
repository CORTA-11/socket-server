---
status: accepted
---

# Live synchronization is not document authority

The socket server owns live Document Rooms and Presence, but it is not the durable source of truth for a Document. Durable collaborative state belongs to the core API and tenant Postgres, so a socket replica or Redis interruption cannot make replica-local or ephemeral state authoritative.
