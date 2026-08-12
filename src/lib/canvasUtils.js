// Helper to create Blobs from canvases based on filter
export function canvasToBlob(canvas, filter) {
  const isColor = filter === 'original' || filter === 'magic';
  const type = isColor ? 'image/jpeg' : 'image/png';
  const quality = isColor ? 0.95 : undefined;
  
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}
