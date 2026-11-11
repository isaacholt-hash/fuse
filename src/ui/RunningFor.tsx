import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/duration";

/** M10 step 11: "Running for 3 min", kept current every second while the run works. */
export function RunningFor({ since, prefix = "Running for " }: { since: number; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return (
    <span aria-label="Running for">
      {prefix}
      {formatDuration(now - since)}
    </span>
  );
}
