export function warp(cv, imageCanvas, corners) {
  let src = null;
  let dst = null;
  let dsize = null;
  let srcTri = null;
  let dstTri = null;
  let M = null;

  try {
    src = cv.imread(imageCanvas);

    // Calculate dimensions of the new image
    const [tl, tr, br, bl] = corners;

    const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
    const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const maxWidth = Math.max(Math.floor(widthA), Math.floor(widthB));

    const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
    const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
    const maxHeight = Math.max(Math.floor(heightA), Math.floor(heightB));

    // Define source and destination points
    let srcCoords = [
      tl.x, tl.y,
      tr.x, tr.y,
      br.x, br.y,
      bl.x, bl.y
    ];
    let dstCoords = [
      0, 0,
      maxWidth, 0,
      maxWidth, maxHeight,
      0, maxHeight
    ];

    srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, srcCoords);
    dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, dstCoords);

    // Get transformation matrix and warp
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    dsize = new cv.Size(maxWidth, maxHeight);
    dst = new cv.Mat();

    cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    // Draw to a new canvas
    const outCanvas = document.createElement('canvas');
    outCanvas.width = maxWidth;
    outCanvas.height = maxHeight;
    cv.imshow(outCanvas, dst);

    return outCanvas;

  } catch (err) {
    console.error("Error during perspective warp", err);
    return imageCanvas;
  } finally {
    if (src) src.delete();
    if (dst) dst.delete();
    if (srcTri) srcTri.delete();
    if (dstTri) dstTri.delete();
    if (M) M.delete();
  }
}
