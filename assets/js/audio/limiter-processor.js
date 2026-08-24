// AudioWorkletProcessor implementing a lookahead peak limiter -- the final
// stage of playback-engine.js's shared master bus (see createMasterBus).
// Not an ES module -- AudioWorklet's addModule() loads this as its own
// worklet-global script (registerProcessor is a worklet-global, not an
// import), so it stays a plain classic script like the rest of this
// no-build-step app's non-module files.
//
// Exists because the two instrumental/vocal stems for a recording are
// separated and independently loudness-rescaled by
// scripts/separate_stems.py, which has no way to know this app always
// plays them back summed -- and now that the two can also be
// independently boosted (playback-engine.js's setStemTrackVolumes), the
// combined peak depends on whatever mix the Pathfinder's dialed in, not
// just the source material.
//
// A plain DynamicsCompressorNode was tried first and wasn't enough alone:
// it has no true lookahead, so a genuinely sharp transient can still punch
// through in the few milliseconds before its gain reduction engages
// (confirmed live: occasional pops survived). Stacking a WaveShaperNode
// soft-clip after it made things *worse* -- its curve had to start bending
// well below 0dBFS to have any safety margin at all, which meant it was
// audibly coloring ordinary loud (non-clipping) passages, not just the
// rare true peak.
//
// This fixes the root issue directly: delay the signal by
// `lookaheadSamples` before it reaches the output, while continuously
// computing the gain reduction needed for the *undelayed* (just-arrived)
// input and smoothing that gain toward its target using a coefficient
// tuned to fully converge within lookaheadSamples samples (see
// coeffForSamples). Because the smoothing runs on the early copy but is
// applied to the delayed copy, by the time any given sample reaches the
// front of the delay line the gain has already had exactly enough time to
// ramp down to what that sample needs -- true zero-overshoot limiting, not
// a reactive one. Both channels share one gain (stereo-linked) so the mix
// doesn't shift image during a limiting event. A final hard clamp is a
// zero-cost backstop for the sub-percent residual the exponential
// smoothing doesn't fully close, not a second stage doing real work.
//
// Same algorithm as audio/limiter-math.js's applyLookaheadLimiter,
// duplicated (not imported, see file-top comment) so that pure math has
// automated test coverage (tests/limiter-math.test.mjs) -- keep the two in
// sync by hand if either changes.
class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~6ms -- enough for the exponential gain smoothing below to
    // essentially fully converge before a peak reaches the output, while
    // staying short enough that the added latency is inaudible for
    // pre-recorded playback (and tiny next to the pitch-shift worklet's
    // own ~93ms grain-length latency, already an accepted trade-off --
    // see that file's doc comment).
    this.lookaheadSamples = Math.max(32, Math.round(sampleRate * 0.006));
    this.ceiling = 0.98; // ~-0.18dBFS -- a true hard ceiling, not a knee that starts bending earlier (see file-top comment on why that made things worse)
    this.channelBuffers = [];
    this.writeIndex = 0;
    this.gain = 1;
    this.attackCoeff = this.coeffForSamples(this.lookaheadSamples);
    this.releaseCoeff = this.coeffForSamples(sampleRate * 0.2); // ~200ms -- slow enough not to pump on normal dynamics
  }

  coeffForSamples(samples) {
    return 1 - Math.pow(0.02, 1 / samples);
  }

  ensureChannels(count) {
    while (this.channelBuffers.length < count) this.channelBuffers.push(new Float32Array(this.lookaheadSamples));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;
    this.ensureChannels(input.length);

    const frameCount = input[0].length;
    for (let frame = 0; frame < frameCount; frame++) {
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) {
        const abs = Math.abs(input[ch][frame] ?? 0);
        if (abs > peak) peak = abs;
      }

      const target = peak > this.ceiling ? this.ceiling / peak : 1;
      const coeff = target < this.gain ? this.attackCoeff : this.releaseCoeff;
      this.gain += (target - this.gain) * coeff;

      const readIndex = this.writeIndex; // oldest slot -- about to be overwritten, which is exactly the sample due for output this frame
      for (let ch = 0; ch < input.length; ch++) {
        const delayed = this.channelBuffers[ch][readIndex];
        const limited = delayed * this.gain;
        output[ch][frame] = Math.max(-this.ceiling, Math.min(this.ceiling, limited));
        this.channelBuffers[ch][readIndex] = input[ch][frame] ?? 0;
      }
      this.writeIndex = (this.writeIndex + 1) % this.lookaheadSamples;
    }
    return true;
  }
}

registerProcessor("limiter-processor", LimiterProcessor);
