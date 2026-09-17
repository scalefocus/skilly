// Client-side square crop for a non-square uploaded icon (§33.4). The server re-normalizes
// unconditionally (§33.3) — this is a UX nicety so the proposer picks WHICH square gets kept,
// not a security boundary. `offsetFraction` (0..1) slides the crop window along whichever axis
// is longer; 0.5 is a centred crop.
export async function loadImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("could not read the image"));
      img.src = url;
    });
    return dims;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Crop `file` to a centred-or-offset square (side = the shorter dimension) and return a PNG blob. */
export async function cropImageToSquare(file: File, offsetFraction = 0.5): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("could not read the image"));
      img.src = url;
    });
    const { naturalWidth: w, naturalHeight: h } = img;
    const side = Math.min(w, h);
    const maxX = w - side;
    const maxY = h - side;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const sx = maxX > 0 ? Math.round(maxX * clamp(offsetFraction)) : 0;
    const sy = maxY > 0 ? Math.round(maxY * clamp(offsetFraction)) : 0;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas not supported");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, side, side);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode the crop"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
