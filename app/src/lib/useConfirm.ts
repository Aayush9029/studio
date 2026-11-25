import { useCallback, useEffect, useRef, useState } from "react";

/** Inline two-step confirmation: first click arms for `ms`, second click runs (§1.1 rule 4). */
export function useConfirm(ms = 3000): { armed: boolean; press(run: () => void): void; disarm(): void } {
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const disarm = useCallback(() => {
    window.clearTimeout(timer.current);
    setArmed(false);
  }, []);
  const press = useCallback(
    (run: () => void) => {
      if (armed) {
        disarm();
        run();
        return;
      }
      setArmed(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(false), ms);
    },
    [armed, disarm, ms],
  );
  return { armed, press, disarm };
}
