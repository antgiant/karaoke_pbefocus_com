// Minimal transport bar shared by study modes and (later) sleep mode: play/pause,
// previous/next section, and a position readout. Pure DOM wiring around a
// playback-engine instance -- no rendering of lyrics itself.

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function mountPlayerControls(container, engine) {
  container.innerHTML = "";
  container.className = "player-controls";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn secondary";
  prevBtn.textContent = "⏮ Previous";

  const playPauseBtn = document.createElement("button");
  playPauseBtn.type = "button";
  playPauseBtn.className = "btn";
  playPauseBtn.textContent = "Play";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn secondary";
  nextBtn.textContent = "Next ⏭";

  const status = document.createElement("div");
  status.className = "player-status";

  container.append(prevBtn, playPauseBtn, nextBtn, status);

  prevBtn.addEventListener("click", () => engine.skipToPreviousBlock());
  nextBtn.addEventListener("click", () => engine.skipToNextBlock());
  playPauseBtn.addEventListener("click", () => engine.toggle());

  function renderStatus(block, blockIndex, totalBlocks, currentTimeInBlock) {
    if (!block) {
      status.textContent = "";
      return;
    }
    const elapsed = formatTime(Math.max(0, currentTimeInBlock - block.inTime));
    const duration = formatTime(block.outTime - block.inTime);
    status.textContent = `${block.label} · ${elapsed} / ${duration} · section ${blockIndex + 1} of ${totalBlocks}`;
  }

  const unsubscribers = [
    engine.on("playstate", (isPlaying) => {
      playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
    }),
    engine.on("blockchange", (block, blockIndex) => {
      renderStatus(block, blockIndex, engine.getState().totalBlocks, block.inTime);
    }),
    engine.on("timeupdate", (t, block, blockIndex) => {
      renderStatus(block, blockIndex, engine.getState().totalBlocks, t);
    }),
    engine.on("ended", () => {
      playPauseBtn.textContent = "Play";
      status.textContent = "Finished";
    }),
  ];

  return function unmount() {
    for (const off of unsubscribers) off();
  };
}
