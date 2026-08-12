import { PDFDocument } from 'pdf-lib';

export async function makePdfBlob(canvas) {
  // Create a new PDFDocument
  const pdfDoc = await PDFDocument.create();

  // Convert canvas to JPEG bytes
  const jpgDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const jpgBase64 = jpgDataUrl.split(',')[1];
  
  // Convert base64 to Uint8Array
  const byteString = atob(jpgBase64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }

  // Embed the JPG image bytes and dimensions
  const image = await pdfDoc.embedJpg(bytes);
  
  // Create a page with the same dimensions as the image
  const page = pdfDoc.addPage([image.width, image.height]);
  
  // Draw the image on the page
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });

  // Serialize the PDFDocument to bytes (a Uint8Array)
  const pdfBytes = await pdfDoc.save();
  
  // Return as Blob
  return new Blob([pdfBytes], { type: 'application/pdf' });
}

export async function makePdfFromPages(pages) {
  const pdfDoc = await PDFDocument.create();
  
  for (const p of pages) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    let image;
    
    if (p.blob.type === 'image/png') {
      image = await pdfDoc.embedPng(bytes);
    } else {
      image = await pdfDoc.embedJpg(bytes);
    }
    
    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  
  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}
