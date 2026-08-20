import { qrcode } from "./vendor/qrcode-generator.mjs";

/**
 * Renders `text` (expected: a share URL, see share.js/main.js) as a QR
 * code SVG string. typeNumber 0 = auto-pick the smallest QR version that
 * fits; error correction 'M' (~15% recoverable) balances scan reliability
 * against code density -- 'L' packs more data but is less forgiving of a
 * damaged/low-quality scan, 'H' is overkill for a code someone's going to
 * scan fresh off a screen. cellSize/margin are in SVG user units, not
 * pixels -- the SVG has no fixed width/height, so it scales cleanly via
 * CSS wherever it's inserted.
 */
export function renderQrCodeSvg(text, { cellSize = 4, margin = 4 } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(cellSize, margin);
}
