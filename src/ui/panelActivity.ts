import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from "react";

/** Hidden panels keep ordinary drafts, while portals and sensitive fields follow visibility. */
export const PanelActivity = createContext(true);
export const usePanelActive = () => useContext(PanelActivity);

export function usePanelLeave(onLeave: () => void) {
  const active = usePanelActive();
  const leave = useEffectEvent(onLeave);
  useEffect(() => {
    if (!active) leave();
  }, [active]);
}

/** A request cannot reveal material after leaving, even if its panel is reopened first. */
export function usePanelRequestGuard(activeOverride?: boolean) {
  const panelActive = usePanelActive();
  const active = activeOverride ?? panelActive;
  const lifecycle = useRef({ active, generation: 0 });
  useLayoutEffect(() => {
    lifecycle.current = { active, generation: lifecycle.current.generation + 1 };
    return () => {
      lifecycle.current = { active: false, generation: lifecycle.current.generation + 1 };
    };
  }, [active]);
  return () => {
    const generation = lifecycle.current.generation;
    return () => lifecycle.current.active && lifecycle.current.generation === generation;
  };
}
