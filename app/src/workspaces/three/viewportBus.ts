/* Three-free bridge between the 3D workspace chrome and the lazily loaded viewport chunk. */

export type CameraPreset = "front" | "side" | "top" | "iso" | "reset";

interface ViewportHandle {
  preset(p: CameraPreset): void;
  reframe(): void;
}

let handle: ViewportHandle | null = null;

export const viewportBus = {
  attach(h: ViewportHandle): () => void {
    handle = h;
    return () => {
      if (handle === h) handle = null;
    };
  },
  preset(p: CameraPreset): void {
    handle?.preset(p);
  },
  reframe(): void {
    handle?.reframe();
  },
};
