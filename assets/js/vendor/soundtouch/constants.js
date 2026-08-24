// Vendored as-is (unmodified besides stripping the sourceMappingURL comment,
// whose .map file isn't vendored) from npm `@soundtouchjs/audio-worklet@2.1.1`,
// `.dist/constants.js` -- https://github.com/cutterbl/SoundTouchJS
// (packages/audio-worklet). MPL-2.0, see ./LICENSE. Swapped in for the old
// hand-rolled granular pitch-shift-processor.js -- SoundTouch's WSOLA
// algorithm sounds meaningfully better than that 2-grain implementation.

/**
 * Registered processor identifier used by `AudioWorkletNode`.
 *
 * @remarks
 * This constant is used to identify the SoundTouch processor module when registering and constructing nodes.
 */
export const PROCESSOR_NAME = 'soundtouch-processor';
/**
 * Default internal buffer strategy used when callers do not provide one.
 *
 * @remarks
 * Determines the default buffer implementation for the SoundTouch processing pipeline.
 */
export const DEFAULT_SAMPLE_BUFFER_TYPE = 'circular';