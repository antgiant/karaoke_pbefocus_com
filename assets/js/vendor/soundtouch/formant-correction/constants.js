// Vendored as-is (unmodified besides stripping the sourceMappingURL comment,
// whose .map file isn't vendored) from npm
// `@soundtouchjs/formant-correction-worklet@2.1.1`, `.dist/constants.js` --
// https://github.com/cutterbl/SoundTouchJS
// (packages/formant-correction-worklet). MPL-2.0, see ../LICENSE (shared
// across the whole vendored soundtouch/ tree -- same monorepo, same
// license). Own constants.js (not the sibling ../constants.js) because the
// two packages' PROCESSOR_NAME/DEFAULT_SAMPLE_BUFFER_TYPE exports collide
// by name but differ in value/content.

/**
 * Registered processor identifier used by `AudioWorkletNode`.
 */
export const PROCESSOR_NAME = 'formant-correction-processor';
/**
 * Default internal buffer strategy used when callers do not provide one.
 */
export const DEFAULT_SAMPLE_BUFFER_TYPE = 'circular';
/** LPC predictor order used for formant envelope estimation. */
export const LPC_ORDER = 16;
/** Analysis window length in samples used to compute LPC coefficients. */
export const LPC_WINDOW = 512;
