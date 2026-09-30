# disk-collision-sim

Event-driven 2D smooth-disk collision and impulse simulation backend.

- TypeScript + Node.js (>= 22, tested on Node 25), SQLite via the built-in
  `node:sqlite` module. **Zero runtime dependencies** (TypeScript/tsx are dev
  only). No web page, no rendering, no third-party physics engine.
- Smooth, rotation-free, gravity-free disks inside an axis-aligned rectangle.
- Continuous collision detection (CCD): disk–disk contact times are found by
  solving the quadratic `|pA(t)-pB(t)| = rA+rB`; disk–wall times are linear
  boundary-crossing roots. The simulator advances analytically to the earliest
  event instead of checking overlap at coarse steps, so arbitrarily fast disks
  cannot tunnel.
- Normal impulse response with coefficient of restitution `e in [0,1]`.

## Numerical method, tolerances and ordering

All tolerances are defined in one place (`src/types.ts`, `TOL_DEFAULTS`) and
stored on every collision record:

- `contactEps = 1e-9` — gap treated as touching;
- `restingSpeed = 1e-9` — normal speed threshold for approaching/resting/
  separating classification (`classifyApproach`);
- `timeEps = 1e-12` — simultaneous-event window and zero-dt threshold;
- `slop`, `maxIterations = 32`, `velocityTol = 1e-11` — impulse solver;
- `maxZeroDtEvents = 256` — stuck-loop guard.

At each instant, **all** contacts within `timeEps` of the earliest time form
one simultaneous group, sorted deterministically by `(kind, diskA, diskB)`.
The group is solved with **sequential impulse (iterative relaxation)**: the
restitution term is applied once on the first sweep and later sweeps only
remove residual approach. Iteration count and a `converged` flag are recorded.

This is a deterministic **iterative approximation**, not an exact unique
solution: a general simultaneous multi-contact rigid impact has no unique
analytic impulse partition without an additional impact/complementarity law.
A zero-time event streak beyond `maxZeroDtEvents` (or a non-converged solver)
stops the run and records the reason in `runtime.stopped_reason`.

Normal convention: for disk–disk contacts `n` points from disk B toward disk A
(`a-b` normalized); for wall contacts `n` points inward from the wall toward
the disk. The receiving body gets impulse `+j*n`. Reported `wallImpulse` is
the external impulse delivered to the disks by the walls, hence
`momentum_now = momentum_initial + wallImpulse` — a wall bounce is **not** a
momentum-conservation failure of the disk subsystem.

## Validation and rejection

Scene creation rejects (stable error codes) non-positive/non-finite radius or
mass, `e` outside `[0,1]`, duplicate disk ids, disks outside the container,
disks that do not fit, and any initial disk–disk or disk–wall penetration.

## Layout

- `src/physics/ccd.ts` — analytic contact roots, KE/momentum helpers;
- `src/physics/impulse.ts` — approach classification and impulse solver;
- `src/physics/engine.ts` — deterministic event-driven `advance` + reports;
- `src/physics/validate.ts` — scene validation;
- `src/db.ts` — SQLite open + repeatable idempotent migrations;
- `src/repo.ts` — transactional persistence, idempotency store, pagination;
- `src/service.ts` — orchestration, pause/resume (= run again), restitution
  comparison clone;
- `src/api.ts`, `src/server.ts` — loopback-only JSON HTTP API;
- `src/cli.ts` — CLI; `src/scenes.ts` — fictional deterministic presets.

## Install, build, test

```powershell
npm install
npm run build
npm test
```

`npm test` runs the Node built-in test runner through `tsx` (30 tests):
analytic two-body checks (equal/unequal mass), grazing, pursuit, high-speed
wall impact, simultaneous contacts, free flight, elastic conservation,
inelastic non-increase of energy, non-penetration, restitution consistency,
zero-dt loop stop, deterministic continuation, persistence/restart,
idempotency, transaction rollback, pagination and HTTP failure paths.

## CLI

```powershell
node dist/cli.js help

# fictional presets: headon unequal grazing pursuit highspeedWall simultaneous billiards
node dist/cli.js init headon --name demo
node dist/cli.js run 1 --duration 3                 # shows before/after state + impulses
node dist/cli.js run 1 --duration 2 --key run-2     # idempotency key (replay is a no-op)
node dist/cli.js status 1                            # pause/resume = run again later
node dist/cli.js events 1 --page 1 --page-size 20   # paged collision log
node dist/cli.js event 1 1                          # one record: velocities before/after, j
node dist/cli.js compare 1 --restitution 0 --name soft --duration 4
node dist/cli.js trajectory 1 --out data/traj.csv
node dist/cli.js list
node dist/cli.js demo                                # repeatable end-to-end demo
```

Each `run` prints positions/velocities, total momentum, kinetic energy, wall
external impulse and stop reason before and after, plus every new contact with
its normal, impulse magnitude, pre/post velocities, iteration count,
convergence and the tolerance parameters used.

## HTTP server (local only)

```powershell
# starts detached, binds 127.0.0.1 with an OS-assigned free port (port 0),
# writes data/server.json with port/pid, and only manages this project's files
node dist/cli.js serve
node dist/cli.js stop

# or in the foreground:
npm start                 # DISK_SIM_PORT / DISK_SIM_DB / DISK_SIM_INFO optional
```

Endpoints (JSON):

- `GET  /health`
- `POST /scenes` — body `{name,width,height,restitution,disks:[{id,r,m,x,y,vx,vy}]}`,
  send `Idempotency-Key` header for repeat-safe submission;
- `GET  /scenes?page=&pageSize=`
- `GET  /scenes/{id}` — full state, momentum, KE, wall impulse, tolerances;
- `POST /scenes/{id}/run` — `{duration}` (+ `Idempotency-Key`);
- `GET  /scenes/{id}/events?page=&pageSize=`
- `GET  /scenes/{id}/events/{seq}`
- `GET  /scenes/{id}/trajectory`
- `POST /scenes/{id}/compare-restitution` — `{name,restitution}` clones geometry.

Errors return `{error:{code,message,details}}` with codes such as
`INVALID_CONTAINER`, `INVALID_MASS`, `INVALID_RADIUS`, `INVALID_RESTITUTION`,
`INITIAL_OVERLAP`, `DISK_DOES_NOT_FIT`, `DISK_OUT_OF_BOUNDS`, `NAME_CONFLICT`,
`INVALID_DURATION`, `SCENE_STOPPED`, `NOT_FOUND`, `INVALID_JSON`, `NO_ROUTE`.

## Determinism, persistence and cleanup

All runtime state (time, event sequence, disk states, accumulated wall
impulse, stop reason) is committed in one SQLite transaction per run, so
stopping and restarting the process gives bit-for-bit identical continuation.
Clock/ids are injected in tests; fictional scenes contain no randomness. All
databases, trajectories and the server info file live under `./data`. The
`serve`/`stop` commands only start/kill the pid recorded in
`data/server.json` (this project's server).
