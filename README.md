# disk-collision-sim

Event-driven, impulse-based **2D smooth-disk collision simulation backend**.

TypeScript + Node.js (built-in `node:sqlite`) with an HTTP API, a CLI, a
fictitious demo scene and an automated test suite. There is **no web UI, no
rigid-body renderer and no third-party physics engine** — contact times are
solved analytically and contacts are resolved with normal impulses.

## Physical model

- Axis-aligned rectangular container; disks are circles with constant
  `radius`, `mass`, position, velocity and coefficient of restitution `e`.
- **No gravity, no rotation, frictionless (smooth) contacts.**
- Pairwise restitution is `e = sqrt(e_i · e_j)`; a wall uses the disk's own `e`.
- **Event-driven integration.** For each step the earliest contact is found
  analytically:
  - disk–disk: solve `|r_b(t)-r_a(t)| = r_a+r_b` exactly (a quadratic),
  - disk–wall: linear `gap(t) = 0`.

  Positions are advanced straight to the exact contact instant, so high-speed
  disks cannot tunnel through walls or each other — there is no coarse
  end-of-timestep overlap test.
- At a contact the normal impulse is
  `j = -(1+e) v_rel·n / (1/m_a + 1/m_b)` for two disks and
  `j = -(1+e) v·n·m` for an immovable wall.

### Approach / separation, tolerances and simultaneous events

All knobs are public and stored on **every collision record**
(`src/physics/types.ts`, `DEFAULT_TOLERANCE`):

| knob | default | meaning |
| --- | --- | --- |
| `epsilonPos` | `1e-9` | contact-distance / penetration slack in length units |
| `epsilonVel` | `1e-11` | relative normal speed below which contact is "resting" |
| `epsilonTime` | `1e-12` | times within this are treated as the same instant |
| `maxIterations` | `64` | cap for the simultaneous-contact solver |
| `toleranceVel` | `1e-10` | residual approach-speed convergence threshold |

A pair is **approaching** when its signed relative normal speed is negative
(beyond `epsilonVel`), **separating/resting** otherwise; resting contacts emit
no impulse. Equal-time contacts are grouped within `epsilonTime` and sorted
deterministically by `time → kind (disk-disk before wall) → participant ids →
wall side` (`compareEvents`).

**Simultaneous multi-contact method — deterministic sequential impulse
approximation, not an exact unique solution.** Contacts are visited in the
fixed order above, each applying non-penetrating impulses; sweeps repeat until
the largest residual approach speed is below `toleranceVel` or
`maxIterations` is reached. A single isolated contact converges in one sweep
to the analytic impulse. Over-constrained/corner jams can reach the cap; the
record then reports `converged:false`. If more than `max(8, 2·maxIterations)`
consecutive **zero-time** groups occur without forward progress the run stops
and stores `stop_reason = "EVENT_LOOP_LIMIT: ..."` instead of looping forever.

## Validation / rejected states

Stable error codes are returned (`VALIDATION`, `BAD_CONTAINER`,
`NON_POSITIVE_MASS`, `NON_POSITIVE_RADIUS`, `BAD_RESTITUTION`,
`INITIAL_PENETRATION`, `DISK_DOES_NOT_FIT`, `CONFLICT`, `NOT_FOUND`,
`EVENT_LOOP_LIMIT`, `BAD_REQUEST`). Creation rejects:

- non-positive mass or radius, restitution outside `[0,1]`,
- a disk whose diameter exceeds a container dimension,
- any initial disk–disk or disk–wall overlap beyond `epsilonPos`.

## Persistence & determinism

SQLite tables (`scenes`, `disks`, `collisions`, `trajectory`, `run_requests`)
are created by idempotent, tracked migrations (`src/db/migrate.ts`) that are
safe to re-run. Every run is a single transaction; failures roll back scene
time, disk states, collisions and trajectory together. After a run the advanced
disk states are written back, so reopening the database and running again
continues deterministically. A monotonic `version` increments per collision
group. `POST` accepts an `Idempotency-Key` header (or `idempotencyKey` body);
re-submitting the same key replays the stored result without re-simulating.

`/stats` reports disk momentum, kinetic energy and **net wall impulse**. A wall
bounce changes disk momentum; that change is exactly the momentum transferred
to the immovable container, not a conservation violation (`p_disk + p_wall`
stays constant).

## Requirements

- Node.js **>= 22.5** (developed on Node 25) for the built-in SQLite bindings
  and TypeScript stripping.
- Windows PowerShell for the start/stop helpers. Everything lives in this
  project: data under `./data`, runtime files under `./tmp`.

## Install

```powershell
npm install
```

## Test

```powershell
npm test
npm run typecheck
```

The suite (26 tests) covers analytic two-body collisions (equal and unequal
mass), restitution consistency, grazing and catch-up contacts, a high-speed
wall bounce, simultaneous corner contact, free flight, elastic energy
conservation, inelastic non-increase of energy, impenetrability, validation
failure paths, transaction rollback, restart persistence and HTTP end-to-end
behaviour. The clock/database are injected in tests; the demo deletes and
rebuilds its own database so it is fully repeatable.

## Run the API server

```powershell
# Option A (foreground; automatic free port, bound to 127.0.0.1 only)
npm run serve

# Option B (background; manages only this project's node process)
powershell -ExecutionPolicy Bypass -File scripts/start.ps1
Get-Content tmp/server.url                 # e.g. http://127.0.0.1:63165
powershell -ExecutionPolicy Bypass -File scripts/stop.ps1
```

Override with `DISK_SIM_PORT` (default `0` = automatic) and
`DISK_SIM_DB` (default `./data/disk-sim.sqlite`). The server never binds a
non-loopback interface.

### HTTP API

| method & path | purpose |
| --- | --- |
| `GET  /api/health` | liveness |
| `POST /api/scenes` | create scene (body below; supports `Idempotency-Key`) |
| `GET  /api/scenes?limit=&offset=` | paginated scene list |
| `GET  /api/scenes/:id` | full state: disks, time, version, tolerance, paused |
| `POST /api/scenes/:id/run` | body `{ "targetTime": T, "tolerance"?: {...} }` |
| `POST /api/scenes/:id/pause` / `/resume` | pause / resume |
| `GET  /api/scenes/:id/collisions?limit=&offset=` | paginated collision records |
| `GET  /api/scenes/:id/trajectory[?diskNo=N]` | sampled trajectories |
| `GET  /api/scenes/:id/stats` | momentum, KE, wall impulse, version, stop reason |

Errors look like `{ "error": { "code": "...", "message": "...", "details": ... } }`
with HTTP status 400/404/409/422/500.

Create body example:

```json
{
  "name": "demo",
  "container": { "width": 20, "height": 10 },
  "disks": [
    { "radius": 1, "mass": 1, "restitution": 1.0,
      "pos": { "x": 2, "y": 5 }, "vel": { "x": 3, "y": 0 } }
  ]
}
```

## CLI

```powershell
npm run build
node --experimental-sqlite dist/src/cli/index.js help
node --experimental-sqlite dist/src/cli/index.js init-demo
node --experimental-sqlite dist/src/cli/index.js run 1 --time 3
node --experimental-sqlite dist/src/cli/index.js collisions 1 --limit 20
node --experimental-sqlite dist/src/cli/index.js pause 1
node --experimental-sqlite dist/src/cli/index.js resume 1
node --experimental-sqlite dist/src/cli/index.js compare 1 --time 2 --e 0,0.5,1
node --experimental-sqlite dist/src/cli/index.js export 1 --out tmp/trajectory.json
node --experimental-sqlite dist/src/cli/index.js stats 1
```

State-changing commands print the state before and after the operation
(momentum, kinetic energy, wall impulse, version, per-disk pos/vel), and the
collision view shows each contact's before/after velocities and impulse vector.

## Repeatable demo

```powershell
npm run demo
```

It rebuilds `./data/demo.sqlite`, runs the fictitious scene, verifies the
analytic equal-mass exchange and wall-impulse balance, compares restitutions,
exercises pause/resume and exports trajectory sample counts.

## Layout

```
src/physics/   types, geometry, analytic contact times, impulses, engine, stats, validation
src/db/        idempotent SQLite migrations + repository/transaction logic
src/api/       loopback HTTP server, routing, pagination, error codes
src/cli/       command-line interface
scripts/       repeatable demo + project-local start/stop
test/          physics, repository and HTTP end-to-end tests
```
