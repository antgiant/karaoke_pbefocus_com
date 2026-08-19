import { orderedSections, passageLabel, sectionKey } from "./library.js";

/** The lowest-take recording for a section in a given style, or null if that style isn't available there. */
export function pickRecording(section, styleId) {
  const candidates = section.recordings.filter((r) => r.style === styleId);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => a.take - b.take)[0];
}

/**
 * Flattens a selection + a single active style into an ordered playback
 * program: one block per selected section, each pointing at one recording's
 * audio file and the word-time slice to play from it.
 *
 * Phase 3 only supports one style for the whole program (no per-word mix
 * yet -- that's program-builder's job to grow into once mix.js exists).
 * Falls back to the "default" style (then to whatever's first) for any
 * selected section that doesn't have a recording in the requested style,
 * and reports every fallback so the UI can tell the Pathfinder about it.
 */
export function buildProgram(manifest, selectedKeys, styleId) {
  const selected = new Set(selectedKeys);
  const blocks = [];
  const fallbacks = [];

  for (const section of orderedSections(manifest)) {
    const key = sectionKey(section);
    if (!selected.has(key)) continue;

    let recording = pickRecording(section, styleId);
    let usedStyle = styleId;
    if (!recording) {
      recording = pickRecording(section, "default") || section.recordings[0];
      usedStyle = recording.style;
      fallbacks.push({ sectionKey: key, label: passageLabel(section), requestedStyle: styleId, usedStyle });
    }

    const words = recording.words;
    if (words.length === 0) continue;

    blocks.push({
      sectionKey: key,
      label: passageLabel(section),
      style: usedStyle,
      take: recording.take,
      audioUrl: recording.audioUrl,
      inTime: words[0].start,
      outTime: words[words.length - 1].end,
      words,
    });
  }

  return { blocks, fallbacks };
}

export function totalDuration(program) {
  return program.blocks.reduce((sum, b) => sum + (b.outTime - b.inTime), 0);
}
