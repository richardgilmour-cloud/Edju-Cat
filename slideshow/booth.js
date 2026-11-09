const slides = [...document.querySelectorAll('.slide')];
const playback = document.getElementById('playback');
const fullscreen = document.getElementById('fullscreen');
const slideDuration = 7500;
const transitionDuration = 850;
let current = 0;
let paused = false;
let advanceTimer;
let transitionTimer;
let controlsTimer;

function schedule() {
  clearTimeout(advanceTimer);
  if (!paused && !document.hidden) {
    advanceTimer = setTimeout(() => showSlide(current + 1), slideDuration);
  }
}

function showSlide(index) {
  const next = (index + slides.length) % slides.length;
  const outgoing = slides[current];
  const incoming = slides[next];
  clearTimeout(transitionTimer);
  slides.forEach(slide => slide.classList.remove('is-leaving'));
  outgoing.classList.add('is-leaving');
  outgoing.classList.remove('is-active');
  outgoing.setAttribute('aria-hidden', 'true');
  incoming.classList.add('is-active');
  incoming.removeAttribute('aria-hidden');
  current = next;
  transitionTimer = setTimeout(() => outgoing.classList.remove('is-leaving'), transitionDuration);
  schedule();
}

function togglePlayback() {
  paused = !paused;
  playback.textContent = paused ? '▶' : 'Ⅱ';
  playback.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
  schedule();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // The page can still fill the browser viewport if fullscreen is unavailable.
  }
}

function showControls() {
  document.body.classList.add('has-controls');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => document.body.classList.remove('has-controls'), 2400);
}

document.getElementById('previous').addEventListener('click', () => showSlide(current - 1));
document.getElementById('next').addEventListener('click', () => showSlide(current + 1));
playback.addEventListener('click', togglePlayback);
fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  fullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Enter full screen');
});
document.addEventListener('visibilitychange', schedule);
document.addEventListener('pointermove', showControls, { passive: true });
document.addEventListener('pointerdown', showControls, { passive: true });
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && event.target instanceof HTMLButtonElement) return;
  if (!['arrowleft', 'arrowright', ' ', 'f'].includes(key)) return;
  event.preventDefault();
  if (key === 'arrowleft') showSlide(current - 1);
  if (key === 'arrowright') showSlide(current + 1);
  if (key === ' ') togglePlayback();
  if (key === 'f') toggleFullscreen();
});

schedule();
