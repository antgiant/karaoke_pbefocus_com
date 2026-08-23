import { test } from "node:test";
import assert from "node:assert/strict";
import { coeffForSamples, applyLookaheadLimiter } from "../assets/js/audio/limiter-math.js";

test("coeffForSamples: repeated application reaches ~98% of a step target within the given sample count", () => {
  const samples = 200;
  const coeff = coeffForSamples(samples);
  let gain = 1;
  const target = 0.2;
  for (let i = 0; i < samples; i++) gain += (target - gain) * coeff;
  assert.ok(Math.abs(gain - target) < (1 - target) * 0.03, `expected gain (${gain}) within ~2% of target (${target})`);
});

test("silence stays silence", () => {
  const out = applyLookaheadLimiter(new Array(1000).fill(0));
  assert.ok(out.every((s) => s === 0));
});

test("a signal comfortably under the ceiling passes through essentially unchanged (after the initial lookahead warm-up)", () => {
  const ceiling = 0.98;
  const lookaheadSamples = 256;
  const samples = new Array(2000).fill(0.5);
  const out = applyLookaheadLimiter(samples, { ceiling, lookaheadSamples });
  for (let i = lookaheadSamples + 50; i < samples.length; i++) {
    assert.ok(Math.abs(out[i] - 0.5) < 0.01, `sample ${i}: expected ~0.5, got ${out[i]}`);
  }
});

test("a single hard impulse never produces an output sample beyond the ceiling", () => {
  const ceiling = 0.98;
  const samples = new Array(2000).fill(0);
  samples[1000] = 5.0; // way over
  const out = applyLookaheadLimiter(samples, { ceiling, lookaheadSamples: 256 });
  for (const s of out) assert.ok(Math.abs(s) <= ceiling + 1e-9, `sample exceeded ceiling: ${s}`);
});

test("a sustained loud tone never exceeds the ceiling, even right at its very first peak", () => {
  const ceiling = 0.98;
  const sampleRate = 44100;
  const samples = [];
  for (let i = 0; i < sampleRate; i++) samples.push(2.0 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)); // 2x over scale, 440Hz
  const out = applyLookaheadLimiter(samples, { ceiling, lookaheadSamples: 256 });
  let maxAbs = 0;
  for (const s of out) maxAbs = Math.max(maxAbs, Math.abs(s));
  assert.ok(maxAbs <= ceiling + 1e-9, `max output ${maxAbs} exceeded ceiling ${ceiling}`);
});

test("after a loud passage ends, gain releases back toward 1 rather than staying clamped down", () => {
  const ceiling = 0.98;
  const lookaheadSamples = 256;
  const loud = new Array(4000).fill(0).map((_, i) => 1.5 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const quiet = new Array(20000).fill(0.3);
  const out = applyLookaheadLimiter([...loud, ...quiet], { ceiling, lookaheadSamples, releaseSamples: 8820 });
  const tailStart = loud.length + lookaheadSamples + 15000; // well after release should have recovered
  for (let i = tailStart; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - 0.3) < 0.01, `sample ${i}: expected recovered ~0.3, got ${out[i]}`);
  }
});
