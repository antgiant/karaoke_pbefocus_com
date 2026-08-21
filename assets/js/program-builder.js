import { alignWordsToCanonical, canonicalWords, orderedSections, passageLabel, pickRecording, sectionKey } from "./library.js";
import { getRuns, parsePaintId } from "./mix.js";

/**
 * Flattens a selection + genre mix into an ordered playback program: one
 * block per contiguous run of canonical words that actually share the same
 * audio source, each pointing at one recording's audio file and the
 * word-time slice to play from it.
 *
 * A run's word range is expressed in canonical (scripture-word) positions,
 * so it's translated into that specific style recording's own timing via
 * alignWordsToCanonical -- see library.js for why raw index alignment
 * across different recordings doesn't work.
 *
 * Two things can make the *actual* audio source for a given canonical word
 * differ from what the mix nominally requested there, both handled the same
 * way -- patch that word in from a reference recording (the Pathfinder's
 * actual selected default style, `mix.defaultStyleId`, or failing that
 * whichever recording happens to be first) instead of silently doing
 * something worse -- and both reported via `fallbacks` so the UI can tell
 * the Pathfinder about it:
 *
 * - The requested style has no recording for this section at all.
 * - The requested style's recording has a genuine alignment gap for that
 *   *specific* word (not the whole run) -- e.g. its own transcript is
 *   missing an earlier short word due to an ASR mishearing, which shifts
 *   every later position-within-verse count off by one. Previously this
 *   silently played from wherever the run's first *successfully* aligned
 *   word happened to land, which could skip several real words' worth of
 *   audio while the display kept showing them -- confusing, and not what
 *   "mixed genre" is supposed to mean. Patching per-word instead of
 *   abandoning the whole run keeps the requested style for everything it
 *   actually has, and only borrows the reference recording for the
 *   specific gap.
 *
 * verseFilter (optional): Map<sectionKey, Set<verseNumber>> -- when a
 * section has an entry, only those verses are included; everything else
 * about the section (its selection, its mix) is unaffected.
 */
export function buildProgram(manifest, mix, selectedKeys, verseFilter) {
  const selected = new Set(selectedKeys);
  const blocks = [];
  const fallbacks = [];

  for (const section of orderedSections(manifest)) {
    const key = sectionKey(section);
    if (!selected.has(key)) continue;

    const canonical = canonicalWords(section);
    const label = passageLabel(section);
    const runs = getRuns(mix, key);
    const verseSet = verseFilter?.get(key) ?? null;

    // Alignment (word object -> canonical index doesn't apply here; this is
    // canonical index -> that recording's word, or null) computed once per
    // paint id (style + take, see mix.js) actually needed for this section,
    // reused across every run/word that wants it instead of recomputing per
    // run. alignedByRecording is a second index into the same results, keyed
    // by the actual recording resolved -- needed below because a segment's
    // *requested* paint id (e.g. a plain styleId, rank 0) isn't necessarily
    // what re-deriving alignmentFor(seg.styleId) would resolve to once
    // seg.styleId has been normalized back to a real style id.
    const alignmentCache = new Map(); // paintId -> { recording, aligned } | null
    const alignedByRecording = new Map(); // recording -> aligned[]
    function alignmentFor(paintId) {
      if (alignmentCache.has(paintId)) return alignmentCache.get(paintId);
      const { styleId, takeRank } = parsePaintId(paintId);
      const recording = pickRecording(section, styleId, takeRank);
      const result = recording ? { recording, aligned: alignWordsToCanonical(canonical, recording.words) } : null;
      alignmentCache.set(paintId, result);
      if (result) alignedByRecording.set(recording, result.aligned);
      return result;
    }

    const fallback =
      (mix.defaultStyleId ? alignmentFor(mix.defaultStyleId) : null) ||
      (section.recordings[0] ? alignmentFor(section.recordings[0].style) : null);

    // One resolved source per canonical index: which recording actually
    // supplies audio for that word, and why it differs from the request
    // (if it does). null means excluded (verse filter) or truly
    // unavailable anywhere (rare). `styleId` on each entry is always a real
    // manifest style id (never a paint id with a take suffix) -- the actual
    // take used is implicit in which `recording` got resolved.
    const plan = canonical.map((cw, i) => {
      if (verseSet !== null && !verseSet.has(cw.verse)) return null;

      const run = runs.find((r) => i >= r.startIndex && i <= r.endIndex);
      const requestedPaintId = run ? run.styleId : mix.defaultStyleId;
      const requestedStyleId = parsePaintId(requestedPaintId).styleId;
      const requested = alignmentFor(requestedPaintId);
      const requestedWord = requested?.aligned[i];
      if (requestedWord) {
        return { styleId: requested.recording.style, recording: requested.recording, word: requestedWord };
      }

      const reason = requested ? "alignment-gap" : "style-unavailable";
      if (fallback?.aligned[i]) {
        return { styleId: fallback.recording.style, recording: fallback.recording, word: fallback.aligned[i], fallbackFrom: requestedStyleId, reason };
      }
      return { unavailable: true, fallbackFrom: requestedStyleId, reason: "no-aligned-audio" };
    });

    // Which verse(s) a canonical index range spans, for readable fallback labels --
    // "1 Peter 2:5" or "1 Peter 2:5-7", not the section label repeated with no way
    // to tell which of several unrelated gaps in the same section a note is about.
    function verseRangeLabel(startIndex, endIndex) {
      const vStart = canonical[startIndex]?.verse;
      const vEnd = canonical[endIndex]?.verse;
      if (vStart === undefined) return label;
      return vStart === vEnd ? `${label}:${vStart}` : `${label}:${vStart}-${vEnd}`;
    }

    // Run-length-encode the plan by (recording, contiguous canonical range) into playable
    // segments -- entries with no recording (verse-filtered out, or truly unavailable
    // anywhere) never join a segment. A segment reports at most one fallback note (from
    // its first patched word) with the verse range it covers, not one per word -- a
    // multi-word gap patched from the same fallback recording is one story, not a flood
    // of identical-looking notes with no way to tell them apart.
    const segments = [];
    let current = null;
    const unavailableRanges = [];
    let unavailableStart = null;
    plan.forEach((entry, i) => {
      if (entry?.unavailable) {
        if (unavailableStart === null) unavailableStart = i;
      } else if (unavailableStart !== null) {
        unavailableRanges.push({ startIndex: unavailableStart, endIndex: i - 1 });
        unavailableStart = null;
      }

      if (!entry?.recording || entry.recording !== current?.recording) {
        if (current) segments.push(current);
        current = entry?.recording
          ? { recording: entry.recording, styleId: entry.styleId, startIndex: i, endIndex: i, fallbackFrom: entry.fallbackFrom, reason: entry.reason }
          : null;
      } else {
        current.endIndex = i;
      }
    });
    if (current) segments.push(current);
    if (unavailableStart !== null) unavailableRanges.push({ startIndex: unavailableStart, endIndex: plan.length - 1 });

    for (const seg of segments) {
      if (seg.fallbackFrom) {
        fallbacks.push({
          sectionKey: key,
          label: verseRangeLabel(seg.startIndex, seg.endIndex),
          requestedStyle: seg.fallbackFrom,
          usedStyle: seg.styleId,
          reason: seg.reason,
        });
      }
    }
    for (const range of unavailableRanges) {
      fallbacks.push({
        sectionKey: key,
        label: verseRangeLabel(range.startIndex, range.endIndex),
        requestedStyle: null,
        usedStyle: null,
        reason: "no-aligned-audio",
      });
    }

    const multiPart = segments.length > 1;
    segments.forEach((seg, segIndex) => {
      const { recording, styleId } = seg;
      // Looked up by the actual recording (not re-derived from styleId,
      // which is always the plain/rank-0 style id here and could resolve to
      // a *different* take than the one this segment actually plays) -- see
      // the alignedByRecording comment above.
      const aligned = alignedByRecording.get(recording);
      const slice = aligned.slice(seg.startIndex, seg.endIndex + 1).filter(Boolean);
      if (slice.length === 0) return;

      const inTime = slice[0].start;
      const outTime = slice[slice.length - 1].end;
      const words = recording.words.filter((w) => w.start >= inTime && w.end <= outTime);

      // Word object -> canonical index, from the FULL recording (not the
      // `words` slice above) -- position-within-verse has to be counted
      // across the whole take, not reset at wherever this segment happens
      // to start/end, or a segment beginning or ending mid-verse gets every
      // word after that point mapped to the wrong canonical index.
      const canonicalIndexMap = new Map();
      aligned.forEach((w, ci) => {
        if (w) canonicalIndexMap.set(w, ci);
      });

      blocks.push({
        sectionKey: key,
        label: multiPart ? `${label} (part ${segIndex + 1}/${segments.length})` : label,
        style: styleId,
        take: recording.take,
        // Every recording in the manifest is a separated instrumental/vocal
        // stem pair (scripts/separate_stems.py + build_manifest.py) --
        // playback-engine.js always plays them together, ducking the vocal
        // per blanked word only when a study mode opts in.
        instrumentalUrl: recording.instrumentalUrl,
        vocalUrl: recording.vocalUrl,
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
