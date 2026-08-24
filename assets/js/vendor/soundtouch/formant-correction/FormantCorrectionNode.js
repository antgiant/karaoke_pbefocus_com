// Vendored as-is (unmodified besides stripping the sourceMappingURL comment,
// whose .map file isn't vendored) from npm
// `@soundtouchjs/formant-correction-worklet@2.1.1`,
// `.dist/FormantCorrectionNode.js` -- https://github.com/cutterbl/SoundTouchJS
// (packages/formant-correction-worklet). MPL-2.0, see ../LICENSE. Used only
// for the vocal stem (playback-engine.js) -- formants are a voice-timbre
// concept, so LPC correction has nothing to preserve on the instrumental
// stem and would just cost extra CPU there for no audible benefit. The
// package's own `index.js` barrel also re-exports `processOffline` (pulls
// in more of `.dist/`), which this app has no use for, so
// playback-engine.js imports this file directly instead of vendoring that
// barrel -- same reasoning as ../SoundTouchNode.js.
/*
 * SoundTouch JS audio processing library
 * Copyright (c) Steve 'Cutter' Blades
 *
 * Licensed under the Mozilla Public License, v. 2.0.
 * You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { DEFAULT_SAMPLE_BUFFER_TYPE, PROCESSOR_NAME } from './constants.js';
/**
 * Main-thread AudioWorkletNode that applies SoundTouch pitch-shifting with
 * LPC-based formant correction.
 *
 * @remarks
 * Wraps `FormantCorrectionProcessor` and provides the same AudioParam accessors
 * as `SoundTouchNode`, plus a `formantStrength` param that controls how strongly
 * the original formant envelope is preserved after pitch shifting.
 *
 * - `formantStrength = 0` — identical output to `SoundTouchNode` (no correction)
 * - `formantStrength = 1` — original formants fully preserved at the new pitch
 *
 * @example
 * ```ts
 * import { FormantCorrectionNode } from '@soundtouchjs/formant-correction-worklet';
 *
 * await FormantCorrectionNode.register(audioCtx, processorUrl);
 * const node = new FormantCorrectionNode({ context: audioCtx });
 * node.pitchSemitones.value = 7;   // up a fifth
 * node.formantStrength.value = 1;  // keep original timbre
 * ```
 */
export class FormantCorrectionNode extends AudioWorkletNode {
    /**
     * The registered processor name for this node type.
     */
    static processorName = PROCESSOR_NAME;
    /**
     * Registers the formant correction processor module with the given AudioContext.
     *
     * @param context - The AudioContext or OfflineAudioContext.
     * @param processorUrl - URL or path to the processor bundle.
     */
    static async register(context, processorUrl) {
        await context.audioWorklet.addModule(processorUrl);
    }
    /**
     * Registers an interpolation strategy installer module in AudioWorkletGlobalScope.
     *
     * @remarks
     * The module should call core registration APIs during evaluation.
     */
    static async registerStrategyModule(context, strategyModuleUrl) {
        await context.audioWorklet.addModule(strategyModuleUrl);
    }
    _lastMetrics = null;
    /**
     * Creates a `FormantCorrectionNode` instance.
     * @param options - Node and processor configuration.
     */
    constructor({ context, sampleBufferType, interpolationStrategy, outputChannelCount, }) {
        super(context, PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [outputChannelCount ?? 2],
            processorOptions: {
                sampleBufferType: sampleBufferType ?? DEFAULT_SAMPLE_BUFFER_TYPE,
                interpolationStrategy,
            },
        });
        this.port.onmessage = (event) => {
            const message = event.data;
            if (message?.type === 'metrics') {
                const metrics = {
                    framesBuffered: message.framesBuffered,
                    underrunCount: message.underrunCount,
                    blockCount: message.blockCount,
                    timestamp: performance.now(),
                };
                this._lastMetrics = metrics;
                this.dispatchEvent(new CustomEvent('metrics', { detail: metrics }));
            }
        };
    }
    /**
     * Returns the most recent processor metrics, or `null` before the first report.
     *
     * @remarks
     * Updated every 100 render blocks. Also dispatched as a `metrics` CustomEvent.
     */
    get metrics() {
        return this._lastMetrics;
    }
    /**
     * Pitch multiplier AudioParam (1.0 = original pitch).
     */
    get pitch() {
        return this.parameters.get('pitch');
    }
    /**
     * Semitone pitch shift AudioParam (integer steps for musical key changes).
     */
    get pitchSemitones() {
        return this.parameters.get('pitchSemitones');
    }
    /**
     * Playback rate AudioParam. Set to match the source node's `playbackRate`
     * for accurate pitch compensation.
     */
    get playbackRate() {
        return this.parameters.get('playbackRate');
    }
    /**
     * Formant correction strength AudioParam (0.0–1.0, k-rate).
     *
     * @remarks
     * - `0.0` — no correction; output is identical to `SoundTouchNode`.
     * - `1.0` — full correction; original vocal formants are preserved at the new pitch.
     * - Intermediate values linearly blend the corrected and uncorrected signals.
     */
    get formantStrength() {
        return this.parameters.get('formantStrength');
    }
    /**
     * Switches interpolation strategy at runtime in the render-thread processor.
     * @param strategy The new interpolation strategy to use.
     */
    setInterpolationStrategy(strategy) {
        this.port.postMessage({
            type: 'set-interpolation-strategy',
            strategy,
        });
    }
    /**
     * Applies a partial params update to the active interpolation strategy.
     * @param params Partial set of parameters to update.
     */
    setInterpolationStrategyParams(params) {
        this.port.postMessage({
            type: 'set-interpolation-strategy-params',
            params,
        });
    }
    /**
     * Applies WSOLA timing parameter updates to the render-thread processor.
     * @param params WSOLA timing parameters.
     */
    setStretchParameters(params) {
        this.port.postMessage({
            type: 'set-stretch-parameters',
            params,
        });
    }
}
