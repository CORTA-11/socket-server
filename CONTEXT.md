# Live Document Collaboration

This context defines the shared language for people editing the same team Document at the same time.

## Language

**Document**:
A team-owned collaborative artifact comprising a title and a rich-text body.
_Avoid_: Doc, file, page

**Editor**:
A Team Member who is actively viewing or changing a Document. Every Team Member may currently become an Editor, and an Editor may continue making local changes during a temporary disconnection.
_Avoid_: Author, writer

**Editing Session**:
One Editor's participation from a single browser tab or device. The same Team Member may have multiple Editing Sessions with distinct cursors, and a session may temporarily be disconnected.
_Avoid_: User, connection

**Document Room**:
The live gathering of Editors connected to one Document. It never includes Editors of another Document, even within the same team.
_Avoid_: Team room, channel

**Presence**:
The transient display name, stable identity, color, cursor or selection, and connection state of an Editing Session in a Document Room.
_Avoid_: Activity, history
