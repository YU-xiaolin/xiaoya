// One owner for each playback, including file loading and cancellation.
export function createSpeechPlayer({ loadClip, createAudio, createUrl, revokeUrl, onUnavailable }) {
  let generation = 0;
  let active = null;

  function cancel() {
    generation += 1;
    const playback = active;
    active = null;
    playback?.finish("cancelled");
  }

  async function speak(text, manifest) {
    cancel();
    if (!text) return "empty";
    const token = generation;
    const clip = manifest?.clips?.[text];
    if (!clip?.fileName) {
      onUnavailable(false);
      return "unavailable";
    }
    let bytes;
    try {
      bytes = await loadClip(clip.fileName);
    } catch {
      if (token !== generation) return "cancelled";
      onUnavailable(true);
      return "unavailable";
    }
    if (token !== generation) return "cancelled";
    let url;
    try {
      url = createUrl(bytes, clip.fileName);
      const audio = createAudio(url);
      return await new Promise(resolve => {
        let finished = false;
        const playback = { finish(status) {
          if (finished) return;
          finished = true;
          // Stop the actual media before releasing its handle or resolving awaiters.
          audio.onended = null;
          audio.onerror = null;
          audio.pause();
          try { audio.currentTime = 0; } catch { /* Metadata may still be loading. */ }
          revokeUrl(url);
          if (active === playback) active = null;
          if (status === "unavailable" && token === generation) onUnavailable(true);
          resolve(status);
        } };
        active = playback;
        audio.onended = () => playback.finish("ended");
        audio.onerror = () => playback.finish("unavailable");
        try {
          Promise.resolve(audio.play()).catch(() => playback.finish("unavailable"));
        } catch { playback.finish("unavailable"); }
      });
    } catch {
      if (url) revokeUrl(url);
      if (token !== generation) return "cancelled";
      onUnavailable(true);
      return "unavailable";
    }
  }

  return { speak, cancel };
}
