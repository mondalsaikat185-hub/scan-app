// Helper to create Blobs from canvases based on filter
export function canvasToBlob(canvas, filter) {
  const isColor = filter === 'original';
  const type = isColor ? 'image/jpeg' : 'image/png';
  const quality = isColor ? 0.92 : undefined;
  
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}
