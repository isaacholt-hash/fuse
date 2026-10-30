/** The tide height at an hour of the day, in centimetres. */
export function tideCm(hour) {
  return Math.round((2 + Math.sin(hour / 2)) * 100);
}
