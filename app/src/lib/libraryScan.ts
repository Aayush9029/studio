/* Debounced Library rescan. Lives outside boot.ts so the engine socket/job router can trigger a
   rescan (e.g. after reconnect reconciliation) without an import cycle. */

import { useLibraryStore } from "../stores/library";
import { studio } from "./studio";

let libraryTimer = 0;
export function loadLibrary(): void {
  window.clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(() => {
    const lib = useLibraryStore.getState();
    lib.setLoading(true);
    studio.library
      .scan()
      .then((r) => useLibraryStore.getState().setItems(r.items))
      .catch(() => {
        const s = useLibraryStore.getState();
        if (!s.loaded) s.setItems([]);
        else s.setLoading(false);
      });
  }, 30);
}
