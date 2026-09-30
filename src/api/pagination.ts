import type { Page } from "../db/repo.js";
import { SimError } from "../physics/validate.js";

export function parsePage(url: URL, defLimit = 50, maxLimit = 200): Page {
  const limitRaw = url.searchParams.get("limit");
  const offsetRaw = url.searchParams.get("offset");
  const limit = limitRaw === null ? defLimit : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit)
    throw new SimError("VALIDATION", `limit must be an integer in [1,${maxLimit}]`);
  if (!Number.isInteger(offset) || offset < 0)
    throw new SimError("VALIDATION", "offset must be a non-negative integer");
  return { limit, offset };
}
