---
status: accepted
---

# Use a dedicated Hocuspocus collaboration service

The existing Go process remains responsible for chat sockets, while a separately scalable Node Hocuspocus service from the socket-server repository owns live Document synchronization and Presence at `/ws/docs`. This uses the Tiptap/Yjs ecosystem without recreating its protocol in Go or making the collaboration service the durable owner of team content.
