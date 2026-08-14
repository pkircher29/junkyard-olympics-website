const CALL_WINDOW_MS = 5 * 60 * 1000;
const ENDING_THRESHOLD_MS = 30 * 1000;

export function callDeadline(calledAt) {
  const startedAt = Date.parse(calledAt);
  return Number.isFinite(startedAt) ? startedAt + CALL_WINDOW_MS : null;
}

export function formatCallCountdown(calledAt, now = Date.now()) {
  const deadline = callDeadline(calledAt);
  if (deadline === null || deadline <= now) return 'Organizer is requeuing this match';
  const remaining = deadline - now;
  if (remaining <= ENDING_THRESHOLD_MS) return 'Call window ending';
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} to check in`;
}

export function createCallCountdownTicker({
  render,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer = null;

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function show(match, { demo = false } = {}) {
    stop();
    if (!match) return;
    if (demo) {
      render(match.deadline);
      return;
    }
    const tick = () => render(formatCallCountdown(match.calledAt, now()));
    tick();
    timer = setIntervalFn(tick, 1000);
  }

  return { show, stop };
}
