/**
 * Scrollbars that show while you are scrolling and fade out once you stop.
 *
 * There is no CSS for this: `::-webkit-scrollbar-thumb` has no "is scrolling"
 * state, and `:hover` is the wrong proxy — it would put a bar on screen for as
 * long as the pointer rests anywhere over the transcript, which is most of the
 * time. So the state comes from the scroll events themselves, and CSS reacts to
 * a class.
 *
 * Scroll events do not bubble, which is why this listens in the capture phase
 * on the document: one listener covers every scrollable region there is now and
 * every one added later, without any of them having to opt in.
 */

const IDLE_MS = 900;

export function installScrollbarAutoHide(target: Document = document): () => void {
  const timers = new WeakMap<HTMLElement, number>();

  const onScroll = (e: Event) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return; // document scroll: nothing to mark
    el.classList.add('scrolling');
    const pending = timers.get(el);
    if (pending) window.clearTimeout(pending);
    timers.set(
      el,
      window.setTimeout(() => el.classList.remove('scrolling'), IDLE_MS),
    );
  };

  target.addEventListener('scroll', onScroll, true);
  return () => target.removeEventListener('scroll', onScroll, true);
}
