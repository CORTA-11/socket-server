# Collaboration capacity exercise

The collaboration process includes a bounded, reproducible exercise for the
first-release operating targets. It uses the public Hocuspocus WebSocket
protocol, the private core-api persistence HTTP contract, and the Prometheus
metrics endpoint. It does not call server hooks directly.

Run it from the repository root after `npm ci`:

```bash
make collaboration-capacity
```

The defaults exercise:

- 25 authenticated Editing Sessions in one Document Room, with one change per
  Editor and convergence checked in every session;
- a Yjs state containing at least 5 MiB of encoded content, loaded through the
  core-api adapter, changed, persisted, and reloaded through a fresh
  collaboration process; and
- 500 simultaneously active Document Rooms, checked through
  `corta_collaboration_active_rooms` and
  `corta_collaboration_active_editing_sessions`.

`CAPACITY_EDITORS_PER_DOCUMENT`, `CAPACITY_DOCUMENT_BYTES`,
`CAPACITY_ACTIVE_ROOMS`, and `CAPACITY_TIMEOUT_MS` can reduce or expand a local
run. These values are exercise targets, not admission limits or latency SLOs.
The timeout only bounds a stuck run. Harness safety ceilings (2,000 rooms, 250
Editors, a 16 MiB generated state, and a 10-minute timeout) prevent accidental
unbounded local allocations; they are deliberately above the agreed targets
and do not configure collaboration-server admission policy.

The JSON report records scenario durations, encoded state sizes, process RSS,
heap and external-memory snapshots, metrics, and any failure. A failed
scenario emits a `status: "failed"` report, destroys its providers and local
servers, and exits non-zero.

## Baseline result

On 2026-09-09, Node.js 22.22.1 on Linux x86_64 completed the default exercise:

| Scenario | Result | Informational duration |
| --- | ---: | ---: |
| 25 Editors in one Document Room | 25 converged; metrics reported 25 sessions and 1 room | 186 ms |
| 5 MiB encoded Document | 5,243,023 bytes loaded; 5,243,062 persisted and reloaded | 537 ms |
| Active Document Rooms | metrics reported 500 sessions and 500 rooms | 1,136 ms |

The run completed in 1,966 ms. RSS increased from 116,719,616 bytes to a
sampled peak of 313,880,576 bytes; sampled peak heap use was 55,741,680 bytes
and sampled peak external memory was 101,037,972 bytes. These measurements are
evidence from one development machine, not production sizing claims.

The exercise identified one large-state validation failure: a whole-string
base64 regular expression overflowed the JavaScript call stack at 5 MiB. The
validator now scans iteratively, with a focused 5 MiB regression test.

The existing 6 MiB Document/WebSocket bounds and 16 MiB persistence-response
bound accommodated the target. Before multi-replica work, repeat this exercise
under representative deployment resources, monitor RSS and persistence
failures over sustained churn, and design distributed room coordination.
Multi-replica failover and exact hard limits at these target values remain out
of scope.
