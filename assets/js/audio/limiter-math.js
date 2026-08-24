// Pure, unit-testable core of playback-engine.js's master limiter's
// lookahead algorithm -- see audio/limiter-processor.js, the
// AudioWorkletProcessor that actually runs this against the real audio
// graph. Duplicated there rather than imported: AudioWorklet modules in
// this app stay plain classic scripts (see limiter-processor.js's file-top
// comment for why). This module exists purely so the algorithm itself has
// automated test coverage (tests/limiter-math.test.mjs) without a real
// AudioWorkletGlobalScope -- keep the two in sync by hand if either changes.

/**
 * One-pole smoothing coefficient that gets a gain envelope ~98% of the way
 * to a new target within `samples` samples -- used for both the attack
 * (matched to the limiter's lookahead delay, so gain reduction is fully
 * converged by the time a loud sample reaches the front of the delay line)
 * and the slower release.
 */
export function coeffForSamples(samples) {
  return 1 - Math.pow(0.02, 1 / samples);
}

/**
 * Runs the whole lookahead-limiter pipeline over a plain array of samples
 * (mono -- the real worklet's multi-channel case just takes the peak
 * across channels as one shared control signal and applies the same gain
 * to every channel, which doesn't change this core math). Returns a
 * same-length Float64Array.
 *
 * Algorithm: delay the signal by `lookaheadSamples` before it reaches the
 * output, while continuously computing the gain reduction needed for the
 * *undelayed* (just-arrived) sample and smoothing that gain toward its
 * target with a coefficient tuned to converge within lookaheadSamples
 * samples (see coeffForSamples). Because the smoothing runs on the early
 * copy but is applied to the delayed copy, by the time any given sample
 * reaches the front of the delay line the gain has already had exactly
 * enough time to ramp down to what that sample needs -- true
 * zero-overshoot limiting, not a reactive one. The final hard clamp is a
 * zero-cost backstop for the sub-percent residual the exponential
 * smoothing doesn't fully close, not a second stage doing real work.
 */
export function applyLookaheadLimiter(samples, { ceiling = 0.98, lookaheadSamples = 256, releaseSamples = 8820 } = {}) {
  const attackCoeff = coeffForSamples(lookaheadSamples);
  const releaseCoeff = coeffForSamples(releaseSamples);
  const buffer = new Float64Array(lookaheadSamples);
  const output = new Float64Array(samples.length);
  let writeIndex = 0;
  let gain = 1;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const peak = Math.abs(x);
    const target = peak > ceiling ? ceiling / peak : 1;
    const coeff = target < gain ? attackCoeff : releaseCoeff;
    gain += (target - gain) * coeff;

    const delayed = buffer[writeIndex];
    output[i] = Math.max(-ceiling, Math.min(ceiling, delayed * gain));
    buffer[writeIndex] = x;
    writeIndex = (writeIndex + 1) % lookaheadSamples;
  }
  return output;
}
