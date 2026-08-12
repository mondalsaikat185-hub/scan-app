let cvReadyPromise = null;

export function loadOpenCV() {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = new Promise((resolve, reject) => {
    if (window.cv && typeof window.cv.Mat === 'function') {
      resolve(window.cv);
      return;
    }

    const script = document.createElement('script');
    script.src = '/opencv.js';
    script.async = true;

    script.onload = () => {
      // OpenCV.js takes a moment to initialize the WASM module
      const start = Date.now();
      const checkInterval = setInterval(() => {
        if (window.cv && window.cv.Mat) {
          clearInterval(checkInterval);
          resolve(window.cv);
        } else if (Date.now() - start > 15000) {
          clearInterval(checkInterval);
          reject(new Error('OpenCV initialization timed out'));
        }
      }, 100);
    };

    script.onerror = () => {
      reject(new Error('Failed to load OpenCV.js'));
    };

    document.body.appendChild(script);
  });

  return cvReadyPromise;
}
