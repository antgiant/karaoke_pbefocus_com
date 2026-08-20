import { test } from "node:test";
import assert from "node:assert/strict";
import { renderQrCodeSvg } from "../assets/js/qr.js";

test("renderQrCodeSvg produces a well-formed SVG string", () => {
  const svg = renderQrCodeSvg("https://example.com/?playlist=abc123");
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
});

test("renderQrCodeSvg scales to fit longer text (auto type-number sizing works)", () => {
  const short = renderQrCodeSvg("x");
  const long = renderQrCodeSvg("x".repeat(500));
  const sizeOf = (svg) => Number(svg.match(/width="(\d+)px"/)[1]);
  assert.ok(sizeOf(long) > sizeOf(short), "a much longer payload should need a visibly larger QR code");
});

test("renderQrCodeSvg round-trips a realistic encoded share payload without throwing", () => {
  // A base64url string, same alphabet/shape share.js's encodePlaylistPayload produces.
  const fakeEncodedPayload = "eyJ2IjoxLCJuYW1lIjoiTWFyayBEcmlsbCJ9".repeat(3);
  assert.doesNotThrow(() => renderQrCodeSvg(`https://example.com/?playlist=${fakeEncodedPayload}`));
});
