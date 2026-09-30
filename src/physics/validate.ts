import type { SceneSpec } from "../types.js";
import { SimError, TOL_DEFAULTS } from "../types.js";
import { diskDiskContact } from "./ccd.js";

/** Structural validation of a scene. Pure; throws SimError with stable codes. */
export function validateScene(spec: SceneSpec): void {
  if (
    !Number.isFinite(spec.width) ||
    !Number.isFinite(spec.height) ||
    spec.width <= 0 ||
    spec.height <= 0
  ) {
    throw new SimError("INVALID_CONTAINER", "width/height must be finite and > 0", {
      width: spec.width,
      height: spec.height,
    });
  }
  if (
    !Number.isFinite(spec.restitution) ||
    spec.restitution < 0 ||
    spec.restitution > 1
  ) {
    throw new SimError("INVALID_RESTITUTION", "restitution must be in [0,1]", {
      restitution: spec.restitution,
    });
  }
  if (!Array.isArray(spec.disks) || spec.disks.length === 0) {
    throw new SimError("NO_DISKS", "scene must contain at least one disk");
  }
  const ids = new Set<number>();
  for (const d of spec.disks) {
    if (!Number.isFinite(d.r) || d.r <= 0) {
      throw new SimError("INVALID_RADIUS", `disk ${d.id} radius must be > 0`, {
        disk: d.id,
      });
    }
    if (!Number.isFinite(d.m) || d.m <= 0) {
      throw new SimError("INVALID_MASS", `disk ${d.id} mass must be > 0`, {
        disk: d.id,
      });
    }
    for (const q of ["x", "y", "vx", "vy"] as const) {
      if (!Number.isFinite(d[q])) {
        throw new SimError("INVALID_STATE", `disk ${d.id}.${q} must be finite`, {
          disk: d.id,
          field: q,
        });
      }
    }
    if (ids.has(d.id)) {
      throw new SimError("DUPLICATE_DISK_ID", `duplicate disk id ${d.id}`, {
        disk: d.id,
      });
    }
    ids.add(d.id);
    // Disk must fit and start fully inside the container.
    if (2 * d.r > spec.width + TOL_DEFAULTS.contactEps || 2 * d.r > spec.height + TOL_DEFAULTS.contactEps) {
      throw new SimError("DISK_DOES_NOT_FIT", `disk ${d.id} larger than container`, {
        disk: d.id,
      });
    }
    if (
      d.x - d.r < -TOL_DEFAULTS.contactEps ||
      d.x + d.r > spec.width + TOL_DEFAULTS.contactEps ||
      d.y - d.r < -TOL_DEFAULTS.contactEps ||
      d.y + d.r > spec.height + TOL_DEFAULTS.contactEps
    ) {
      throw new SimError("DISK_OUT_OF_BOUNDS", `disk ${d.id} outside container`, {
        disk: d.id,
      });
    }
  }
  // Pairwise initial overlap (CCD with horizon 0 only checks overlap state).
  for (let i = 0; i < spec.disks.length; i++) {
    for (let j = i + 1; j < spec.disks.length; j++) {
      diskDiskContact(spec.disks[i]!, spec.disks[j]!, 0, TOL_DEFAULTS);
    }
  }
}
