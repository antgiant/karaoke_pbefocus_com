// AudioWorkletProcessor implementing true pitch shift (a "key change" with
// tempo held constant) via granular synthesis -- see AI_TODO.md item 4's
// "Pitch scope" decision for why this exists instead of relying on
// HTMLMediaElement's native playbackRate/preservesPitch, which can only
// hold pitch *constant* while tempo changes, not shift it independently.
//
// Not an ES module -- AudioWorklet's addModule() loads this as its own
// worklet-global script (registerProcessor is a worklet-global, not an
// import), so it stays a plain classic script like the rest of this
// no-build-step app's non-module files.
//
// Algorithm (granular synthesis / "overlap-add" pitch shifting): two
// overlapping read "grains," each `grainSize` samples long and windowed by
// a triangular envelope, read from a ring buffer that the real-time input
// is continuously written into. Both grains advance through the ring
// buffer at `pitchFactor` samples per output sample (not 1) -- reading
// "faster" or "slower" through the buffered material resamples *within*
// each grain, which shifts its perceived pitch, while grain *boundaries*
// still advance at exactly 1 sample per output sample (tied to the write
// pointer), so overall playback duration/tempo is untouched.
//
// The two grains are kept exactly half a window apart in their own
// progress counters. A triangular window has the property that itself and
// a copy shifted by half its own width sum to exactly 1 at every sample
// (proof: env(p) = 1-|2p/N-1|; env(p) + env((p+N/2) mod N) = 1 for all p)
// -- so no extra normalization/gain-compensation is needed, and each grain
// resets (re-anchors its read position to just behind the write pointer,
// so it's always reading already-written samples regardless of how far
// pitchFactor made it drift) exactly when its own envelope is at 0, making
// that reset's read-position jump inaudible under the other grain's
// full-volume contribution.
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 4096 samples (~85-93ms at typical sample rates) -- large enough for
    // reasonable low-frequency/bass reproduction without too much
    // chorus-y/robotic artifacting; this app pitch-shifts pre-recorded
    // playback, not a live low-latency monitoring path, so the extra
    // grain-length latency this implies is an acceptable trade for quality.
    this.grainSize = 4096;
    this.bufferSize = this.grainSize * 2;
    this.channelBuffers = [];
    this.writeIndex = 0;
    this.grainProgress = [0, this.grainSize / 2]; // staggered half a window apart, permanently (see class doc comment)
    this.grainReadIndex = [0, 0];
    this.initialized = false;
    this.pitchFactor = 1; // 1 = no shift; see karaoke-controls.js's semitonesToRatio for how this is derived
    this.port.onmessage = (event) => {
      const { pitchFactor } = event.data ?? {};
      if (typeof pitchFactor === "number" && pitchFactor > 0) this.pitchFactor = pitchFactor;
    };
  }

  ensureChannels(count) {
    while (this.channelBuffers.length < count) this.channelBuffers.push(new Float32Array(this.bufferSize));
  }

  resetGrain(g) {
    this.grainProgress[g] = 0;
    this.grainReadIndex[g] = (this.writeIndex - this.grainSize + this.bufferSize) % this.bufferSize;
  }

  readInterpolated(buf, fracIndex) {
    const i0 = Math.floor(fracIndex) % this.bufferSize;
    const i1 = (i0 + 1) % this.bufferSize;
    const frac = fracIndex - Math.floor(fracIndex);
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;
    this.ensureChannels(input.length);

    if (!this.initialized) {
      this.resetGrain(0);
      this.resetGrain(1);
      this.grainProgress[1] = this.grainSize / 2;
      this.initialized = true;
    }

    const frameCount = input[0].length;
    for (let frame = 0; frame < frameCount; frame++) {
      for (let ch = 0; ch < input.length; ch++) {
        this.channelBuffers[ch][this.writeIndex] = input[ch][frame] ?? 0;
      }

      for (let ch = 0; ch < input.length; ch++) {
        const buf = this.channelBuffers[ch];
        let sample = 0;
        for (let g = 0; g < 2; g++) {
          const envelope = 1 - Math.abs((2 * this.grainProgress[g]) / this.grainSize - 1);
          sample += this.readInterpolated(buf, this.grainReadIndex[g]) * envelope;
        }
        output[ch][frame] = sample;
      }

      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      for (let g = 0; g < 2; g++) {
        this.grainReadIndex[g] = (this.grainReadIndex[g] + this.pitchFactor) % this.bufferSize;
        this.grainProgress[g] += 1;
        if (this.grainProgress[g] >= this.grainSize) this.resetGrain(g);
      }
    }
    return true;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);
