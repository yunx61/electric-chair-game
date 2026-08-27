import QRCode from 'qrcode';

export async function renderQr(canvas, text) {
  return QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 260,
    color: { dark: '#07070a', light: '#ffffff' }
  });
}
