import { alignWordsToCanonical, canonicalWords, orderedSections, passageLabel, pickRecording, sectionKey } from "./library.js";
import { getRuns } from "./mix.js";

/**
 * Flattens a selection + genre mix into an ordered playback program: one
 * block per contiguous same-style run (see mix.js/getRuns), each pointing
 * at one recording's audio file and the word-time slice to play from it.
 *
 * A run's word range is expressed in canonical (scripture-word) positions,
 * so it's translated into that specific style recording's own timing via
 * alignWordsToCanonical -- see library.js for why raw index alignment
 * across different recordings doesn't work. Falls back to the "default"
 * style (then to whatever's first) for any run whose requested style has no
 * recording for that section at all, and to skipping the run (rare) if the
 * alignment comes up completely empty (e.g. a rough take with far fewer
 * scripture words than the canonical count) -- both kinds of gap are
 * reported so the UI can tell the Pathfinder about it.
 */
export function buildProgram(manifest, mix, selectedKeys) {
  const selected = new Set(selectedKeys);
  const blocks = [];
  const fallbacks = [];

  for (const section of orderedSections(manifest)) {
    const key = sectionKey(section);
    if (!selected.has(key)) continue;

    const runs = getRuns(mix, key);
    const canonical = canonicalWords(section);
    const label = passageLabel(section);
    const multiPart = runs.length > 1;

    runs.forEach((run, runIndex) => {
      let recording = pickRecording(section, run.styleId);
      let usedStyle = run.styleId;
      if (!recording) {
        recording = pickRecording(section, "default") || section.recordings[0];
        usedStyle = recording.style;
        fallbacks.push({ sectionKey: key, label, requestedStyle: run.styleId, usedStyle, reason: "style-unavailable" });
      }

      const aligned = alignWordsToCanonical(canonical, recording.words);
      const slice = aligned.slice(run.startIndex, run.endIndex + 1).filter(Boolean);
      if (slice.length === 0) {
        fallbacks.push({ sectionKey: key, label, requestedStyle: run.styleId, usedStyle, reason: "no-aligned-audio" });
        return;
      }

      const inTime = slice[0].start;
      const outTime = slice[slice.length - 1].end;
      const words = recording.words.filter((w) => w.start >= inTime && w.end <= outTime);

      // Word object -> canonical index, computed once here from the FULL
      // recording (not the `words` slice above) -- position-within-verse
      // has to be counted across the whole take, not reset at wherever this
      // run happens to start/end, or a run beginning or ending mid-verse
      // gets every word after that point mapped to the wrong canonical
      // index. The display layer (word-stream.js) reuses this directly
      // instead of re-deriving it from a slice, which is exactly the bug
      // that caused it to.
      const canonicalIndexMap = new Map();
      aligned.forEach((w, ci) => {
        if (w) canonicalIndexMap.set(w, ci);
      });

      blocks.push({
        sectionKey: key,
        label: multiPart ? `${label} (part ${runIndex + 1}/${runs.length})` : label,
        style: usedStyle,
        take: recording.take,
        audioUrl: recording.audioUrl,
        inTime,
        outTime,
        words,
        canonicalIndexMap,
      });
    });
  }

  return { blocks, fallbacks };
}

export function totalDuration(program) {
  return program.blocks.reduce((sum, b) => sum + (b.outTime - b.inTime), 0);
}

/**
 * Shuffles section order (not word/block order within a section -- a mixed
 * section's runs still play in their own sequence, since that's the actual
 * scripture text order). Groups consecutive same-sectionKey blocks (that's
 * always how buildProgram emits them) and Fisher-Yates shuffles the groups.
 */
export function shuffleBySection(program) {
  const groups = [];
  let current = null;
  for (const block of program.blocks) {
    if (!current || current.sectionKey !== block.sectionKey) {
      current = { sectionKey: block.sectionKey, blocks: [] };
      groups.push(current);
    }
    current.blocks.push(block);
  }
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  return { blocks: groups.flatMap((g) => g.blocks), fallbacks: program.fallbacks };
}
