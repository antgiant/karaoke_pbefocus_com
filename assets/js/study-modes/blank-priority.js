/**
 * Which words invisible-word/blackout-ramp mode should blank first, ported
 * from the sibling pbe-practice-engine tool's fill-in-the-blank word
 * selection (its script.js applyBlanks()/src/utils.js TF-IDF helpers) --
 * same underlying scripture content, same idea that blanking should target
 * words that actually carry meaning rather than uniform randomness.
 *
 * Adapted, not a straight port: pbe-practice-engine tiers priority partly
 * from real part-of-speech tags (via a vendored NLP library) blended with a
 * two-level (verse + chapter) TF-IDF built from a whole-Bible corpus cache.
 * Neither dependency exists here, so word length stands in for noun/verb
 * vs. filler where a POS tag would otherwise decide, and TF-IDF is a single
 * level computed across just the current passage's own verses as documents
 * -- a word frequent in its verse but rare elsewhere in the passage still
 * scores higher, the same signal, just without the larger corpus.
 */

const FUNCTION_WORDS = new Set([
  "and", "or", "but", "nor", "yet", "so", "for",
  "the", "a", "an",
  "in", "on", "at", "to", "from", "by", "with", "about", "against", "between", "into", "through",
  "during", "before", "after", "above", "below", "up", "down", "of", "off", "over", "under", "upon",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "their", "our",
  "this", "that", "these", "those",
  "am", "is", "are", "was", "were", "be", "being", "been",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must", "do", "does", "did", "have", "has", "had",
]);

const PRIORITY_WORDS = new Set([
  "lord", "god", "jesus", "christ", "messiah", "savior", "redeemer", "spirit", "father", "holy", "almighty", "yahweh", "jehovah",
  "adam", "eve", "noah", "abraham", "sarah", "isaac", "rebekah", "jacob", "rachel", "leah", "joseph",
  "moses", "aaron", "miriam", "pharaoh", "joshua", "caleb",
  "gideon", "samson", "deborah", "samuel", "eli",
  "saul", "david", "solomon", "elijah", "elisha", "isaiah", "jeremiah", "ezekiel", "daniel",
  "hosea", "joel", "amos", "obadiah", "jonah", "micah", "nahum", "habakkuk", "zephaniah", "haggai", "zechariah", "malachi",
  "mary", "john", "peter", "paul", "matthew", "mark", "luke", "james", "andrew", "philip", "bartholomew", "thomas", "judas", "simon", "thaddaeus",
  "stephen", "barnabas", "timothy", "titus", "silas", "apollos", "priscilla", "aquila",
  "pilate", "herod", "caesar", "caiaphas",
  "israel", "jerusalem", "zion", "bethlehem", "nazareth", "galilee", "judea", "samaria", "egypt", "babylon", "assyria",
  "canaan", "jordan", "sinai", "horeb", "carmel", "olivet", "gethsemane", "calvary", "golgotha",
  "eden", "babel", "sodom", "gomorrah", "jericho", "damascus", "nineveh", "tarsus", "corinth", "ephesus", "rome", "macedonia", "athens",
  "israelites", "hebrews", "jews", "gentiles", "pharisees", "sadducees", "levites", "priests", "disciples", "apostles",
  "philistines", "egyptians", "babylonians", "assyrians", "romans", "persians", "medes",
]);

const TFIDF_WEIGHT = 0.3;
const PRIORITY_WEIGHT = 0.7;
const MIN_WORD_LENGTH = 2;

function normalizeWord(raw) {
  return (raw || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** 1 (blank first) .. 5 (blank last), same tiers pbe-practice-engine uses. */
function wordPriority(normWord) {
  if (FUNCTION_WORDS.has(normWord)) return 4;
  if (PRIORITY_WORDS.has(normWord)) return 1;
  if (normWord.length <= 3) return 4;
  if (normWord.length >= 7) return 2;
  return 3;
}

/** Higher score = should be blanked before lower-scoring words. Parallel array to `words`. */
export function scoreWords(words) {
  const byVerse = new Map();
  words.forEach((w) => {
    const norm = normalizeWord(w.word);
    if (norm.length < MIN_WORD_LENGTH) return;
    if (!byVerse.has(w.verse)) byVerse.set(w.verse, []);
    byVerse.get(w.verse).push(norm);
  });

  const verseIds = [...byVerse.keys()];
  const tfByVerse = new Map();
  verseIds.forEach((v) => {
    const vwords = byVerse.get(v);
    const freq = {};
    vwords.forEach((w) => {
      freq[w] = (freq[w] || 0) + 1;
    });
    Object.keys(freq).forEach((w) => {
      freq[w] /= vwords.length;
    });
    tfByVerse.set(v, freq);
  });

  const documentFrequency = {};
  verseIds.forEach((v) => {
    new Set(byVerse.get(v)).forEach((w) => {
      documentFrequency[w] = (documentFrequency[w] || 0) + 1;
    });
  });
  const idf = {};
  Object.entries(documentFrequency).forEach(([w, freq]) => {
    idf[w] = Math.log(verseIds.length / freq) + 0.0001; // never a hard zero for a word in every verse
  });

  let maxTfidf = 0;
  const tfidfRaw = words.map((w) => {
    const norm = normalizeWord(w.word);
    const tf = tfByVerse.get(w.verse)?.[norm] ?? 0;
    const score = tf * (idf[norm] ?? 0);
    if (score > maxTfidf) maxTfidf = score;
    return score;
  });

  return words.map((w, i) => {
    const priority = wordPriority(normalizeWord(w.word));
    const priorityScore = (6 - priority) / 5;
    const tfidfScore = maxTfidf > 0 ? tfidfRaw[i] / maxTfidf : 0;
    return tfidfScore * TFIDF_WEIGHT + priorityScore * PRIORITY_WEIGHT;
  });
}

/**
 * Canonical-word indices that should stay revealed (as hints) for a given
 * 0..1 reveal fraction: the least meaning-bearing words (low score) get
 * revealed first, so the passage's most important words stay blanked the
 * longest -- "always blank the words that matter," not uniform randomness.
 */
export function selectHintedIndices(words, revealFraction) {
  const scores = scoreWords(words);
  const order = words.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const revealCount = Math.round(words.length * revealFraction);
  return new Set(order.slice(0, revealCount));
}
