// Keep one media element for the lifetime of the page. Mobile browsers grant
// playback to that element during a tap; fetching a blob before play loses it.
const SILENCE = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==";

async function readCachedClip(fileName) {
  if (!globalThis.caches || !globalThis.document?.baseURI) return null;
  const cache = await caches.open("xiaoya-voice-v1");
  const hit = await cache.match(new URL(`./voice/${fileName}`, document.baseURI).href);
  return hit ? hit.blob() : null;
}

export function createMobileSpeechPlayer({ createAudio = () => new Audio(), timeoutMs = 12000, readCached = readCachedClip } = {}) {
  let audio;
  let active = null;
  let generation = 0;
  let unlocked = false;
  const getAudio = () => audio ||= createAudio();
  function cancel() {
    generation += 1;
    active?.finish("cancelled");
  }
  function unlock() {
    if (unlocked || active) return;
    const token = generation;
    try {
      const media = getAudio();
      media.src = SILENCE;
      media.preload = "auto";
      Promise.resolve(media.play()).then(() => {
        unlocked = true;
        if (token === generation && !active) media.pause();
      }).catch(() => { /* Retry on the next gesture. */ });
    } catch { /* A later explicit play can still succeed. */ }
  }
  function speak(text, manifest) {
    cancel();
    const clip = manifest?.clips?.[text];
    if (!clip?.fileName || !/^[a-zA-Z0-9._-]+\.(mp3|wav)$/i.test(clip.fileName)) return Promise.resolve("unavailable");
    const token = generation;
    return new Promise(resolve => {
      let finished = false;
      let timer;
      let media;
      let objectUrl;
      let recovering = false;
      let sourceAttempt = 0;
      const playback = { finish(status) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (media) {
          media.onended = media.onerror = media.onplaying = null;
          try { media.pause(); } catch { /* Media may not have initialized. */ }
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (active === playback) active = null;
        resolve(token === generation ? status : "cancelled");
      } };
      active = playback;
      async function recover() {
        if (recovering || finished) return;
        recovering = true;
        sourceAttempt += 1; // Ignore the original source's late play rejection.
        try {
          const blob = await readCached(clip.fileName);
          if (finished || token !== generation) return;
          if (!blob) return playback.finish("unavailable");
          objectUrl = URL.createObjectURL(blob);
          media.src = objectUrl;
          playSource();
        } catch { playback.finish("unavailable"); }
      }
      function failed(error) {
        if (error?.name === "NotAllowedError") playback.finish("blocked");
        else if (recovering) playback.finish("unavailable");
        else recover();
      }
      function playSource() {
        const attempt = ++sourceAttempt;
        const reject = error => { if (!finished && attempt === sourceAttempt) failed(error); };
        media.onerror = () => reject();
        Promise.resolve(media.play()).catch(reject);
      }
      try {
        media = getAudio();
        media.preload = "auto";
        media.src = `./voice/${clip.fileName}`;
        media.onended = () => playback.finish("ended");
        media.onplaying = () => {
          clearTimeout(timer);
          timer = setTimeout(() => playback.finish("unavailable"), Math.max(15000, text.length * 600));
          timer?.unref?.();
        };
        timer = setTimeout(() => playback.finish("unavailable"), timeoutMs);
        timer?.unref?.();
        playSource();
      } catch (error) {
        playback.finish(error?.name === "NotAllowedError" ? "blocked" : "unavailable");
      }
    });
  }
  return { speak, cancel, unlock };
}
