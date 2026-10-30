import { formatMetres } from "./format.js";
import { tideCm } from "./tide.js";

/** One line of the tide table. */
export function report(hour) {
  return `Tide: ${formatMetres(tideCm(hour))}`;
}
