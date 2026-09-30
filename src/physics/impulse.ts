import type { DiskState, ToleranceConfig } from "../types.js";
import type { ContactCandidate } from "./ccd.js";

export type ApproachState = "approaching" | "separating" | "resting";

/** Public approach/separation classifier driven by the injected tolerance. */
export function classifyApproach(vn: number, tol: ToleranceConfig): ApproachState {
  if (vn <= -tol.restingSpeed) return "approaching";
  if (vn >= tol.restingSpeed) return "separating";
  return "resting";
}

export interface ResolvedContact {
  contact: ContactCandidate;
  impulse: number;
  before: { avx: number; avy: number; bvx: number; bvy: number };
  after: { avx: number; avy: number; bvx: number; bvy: number };
}

export interface ResolveResult {
  resolved: ResolvedContact[];
  iterations: number;
  converged: boolean;
}

/**
 * Resolve all contacts at one instant with sequential impulse (iterative
 * relaxation). METHOD: contacts are visited in deterministic order
 * (kind, a, b) and each gets a non-negative correcting normal impulse;
 * the sweep repeats until no contact is approaching or maxIterations is hit.
 * This is a deterministic iterative APPROXIMATION for multi-contact stacks /
 * simultaneous impacts: it converges to a feasible non-penetrating post-state
 * but the partition of impulse among simultaneous contacts is NOT claimed to be
 * the unique physical solution (multiple simultaneous rigid impacts generally
 * have no unique analytic answer without a complementarity/impact law).
 */
export function resolveContacts(
  disks: Map<number, DiskState>,
  contacts: ContactCandidate[],
  restitution: number,
  tol: ToleranceConfig,
): ResolveResult {
  const ordered = [...contacts].sort((p, q) => {
    if (p.kind !== q.kind) return p.kind < q.kind ? -1 : 1;
    if (p.a !== q.a) return p.a - q.a;
    return p.b - q.b;
  });

  const accumulated = new Map<number, number>();
  const snapshots = new Map<number, ResolvedContact["before"]>();
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i]!;
    const a = disks.get(c.a)!;
    const b = c.kind === "disk-disk" ? disks.get(c.b)! : null;
    snapshots.set(i, {
      avx: a.vx,
      avy: a.vy,
      bvx: b ? b.vx : 0,
      bvy: b ? b.vy : 0,
    });
    accumulated.set(i, 0);
  }

  let iterations = 0;
  let converged = false;
  for (; iterations < tol.maxIterations; iterations++) {
    let maxDelta = 0;
    let anyApproaching = false;
    // Restitution is applied exactly once per contact on the first sweep;
    // later sweeps use e=0 corrections to remove residual approach caused by
    // the other contacts in the same instant (standard sequential impulse).
    const effectiveE = iterations === 0 ? restitution : 0;
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i]!;
      const a = disks.get(c.a)!;
      const b = c.kind === "disk-disk" ? disks.get(c.b)! : null;
      const invA = 1 / a.m;
      const invB = b ? 1 / b.m : 0;
      const bvx = b ? b.vx : 0;
      const bvy = b ? b.vy : 0;
      let j = 0;
      if (b) {
        // n points B -> A; A receives +j n, B receives -j n.
        const vn = (a.vx - bvx) * c.nx + (a.vy - bvy) * c.ny;
        if (classifyApproach(vn, tol) !== "approaching") continue;
        anyApproaching = true;
        j = (-(1 + effectiveE) * vn) / (invA + invB);
        if (!(j > 0)) continue;
        a.vx += j * invA * c.nx;
        a.vy += j * invA * c.ny;
        b.vx -= j * invB * c.nx;
        b.vy -= j * invB * c.ny;
      } else {
        // Wall: n points inward from the wall toward the disk. The disk is the
        // receiver of +j*n. Approaching means v.n < 0 (moving against n).
        const vn = a.vx * c.nx + a.vy * c.ny;
        if (classifyApproach(vn, tol) !== "approaching") continue;
        anyApproaching = true;
        j = (-(1 + effectiveE) * vn) / invA;
        if (!(j > 0)) continue;
        a.vx += j * invA * c.nx;
        a.vy += j * invA * c.ny;
      }
      accumulated.set(i, (accumulated.get(i) ?? 0) + j);
      maxDelta = Math.max(maxDelta, Math.abs(j * invA), b ? Math.abs(j * invB) : 0);
    }
    if (!anyApproaching) {
      converged = true;
      iterations++;
      break;
    }
    if (maxDelta < tol.velocityTol) {
      // No contact closed further but some remain: resting cluster, treat converged.
      converged = true;
      iterations++;
      break;
    }
  }

  const resolved: ResolvedContact[] = ordered.map((c, i) => {
    const a = disks.get(c.a)!;
    const b = c.kind === "disk-disk" ? disks.get(c.b)! : null;
    return {
      contact: c,
      impulse: accumulated.get(i) ?? 0,
      before: snapshots.get(i)!,
      after: { avx: a.vx, avy: a.vy, bvx: b ? b.vx : 0, bvy: b ? b.vy : 0 },
    };
  });
  return { resolved, iterations, converged };
}
