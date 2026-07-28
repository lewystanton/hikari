/* Render core.

   The old shell rebuilt a whole screen with `el.innerHTML = ...` on every
   state change — and with realtime sync echoing the desktop, that happened
   constantly. Everything downstream of it was broken by design:

     · a focused <input> was destroyed mid-keystroke, so Android tore the
       soft keyboard down the moment a search result landed;
     · entry animations with `both` fill restarted, leaving fresh nodes at
       opacity:0 — which reads as a blank gap where the grid should be;
     · every <img> was recreated, so the poster wall flashed;
     · scroll offsets inside rails were lost.

   So: screens are patched, never rebuilt. morphdom walks the new markup
   against the live DOM and touches only what actually differs. Nodes carry
   `data-key` so lists reconcile by identity instead of index. */
import morphdom from 'morphdom';

const scratch = document.createElement('div');

const isTextEntry = (n) => n instanceof HTMLElement
  && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');

/** Patch `el`'s children toward `html`, preserving focus, scroll and media. */
export function patch(el, html) {
  scratch.innerHTML = html;
  morphdom(el, scratch, {
    childrenOnly: true,
    getNodeKey: (n) => (n.nodeType === 1 ? (n.dataset && n.dataset.key) || n.id || undefined : undefined),
    onBeforeElUpdated(from, to) {
      /* Carry live scroll-driven custom properties across the patch. These are
         set imperatively every frame and the template knows nothing about
         them, so without this the next patch would wipe the parallax and the
         ambient would jump back to the top of the screen. */
      const vars = from.getAttribute('data-vars');
      if (vars) {
        for (const name of vars.split(' ')) {
          const v = from.style.getPropertyValue(name);
          if (v) to.style.setProperty(name, v);
        }
      }
      /* identical subtree — skip it and everything under it */
      if (from.isEqualNode(to)) return false;
      /* NEVER touch the field the user is typing into. Re-creating it (or
         even rewriting its value) is what dismissed the keyboard. */
      if (from === document.activeElement && isTextEntry(from)) return false;
      /* <video> must keep its buffer and playback position */
      if (from.tagName === 'VIDEO') return false;
      /* opt-out for anything JS owns imperatively */
      if (from.hasAttribute('data-keep')) return false;
      return true;
    },
    onBeforeNodeDiscarded(node) {
      /* don't yank the subtree that currently holds focus out from under it */
      if (node.nodeType === 1 && node.contains(document.activeElement)
        && isTextEntry(document.activeElement)) return false;
      return true;
    }
  });
  scratch.textContent = '';
}

/* —— frame-coalesced work ——
   A burst of realtime rows must cost one patch, not one per row.

   CRITICAL: this must NOT be gated on requestAnimationFrame alone. rAF stops
   firing entirely whenever the page isn't compositing — a backgrounded app, a
   screen-off phone, the biometric prompt in front — and work queued behind it
   would simply never run. So we race a frame against a timer and take
   whichever arrives first. */
const pending = new Set();
let frame = 0, timer = 0;
function flush() {
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  if (timer) { clearTimeout(timer); timer = 0; }
  const run = [...pending];
  pending.clear();
  for (const f of run) f();
}
export function schedule(fn) {
  pending.add(fn);
  if (frame || timer) return;
  frame = requestAnimationFrame(flush);
  timer = setTimeout(flush, 32);
}

/* —— scroll handlers ——
   Handlers write CSS custom properties on the SCREEN ROOT rather than inline
   transforms on inner nodes: the root is never patched (childrenOnly), so
   nothing can clobber them, and it's two property writes per frame instead of
   one per animated element. CSS does the rest. */
export function onScrollFrame(el, fn) {
  let ticking = false;
  const handler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; fn(el.scrollTop); });
  };
  el.addEventListener('scroll', handler, { passive: true });
  return handler;
}

/* —— haptics ——
   Native only; a no-op shim on the web preview. Cheap, and the single biggest
   "this is an app, not a web page" signal on Android. */
let H = null;
import('@capacitor/haptics').then((m) => { H = m; }).catch(() => {});
export function tap(style = 'Light') {
  try { H?.Haptics.impact({ style: H.ImpactStyle[style] }); } catch { /* web */ }
}
export function buzz(type = 'Success') {
  try { H?.Haptics.notification({ type: H.NotificationType[type] }); } catch { /* web */ }
}
export function selectionTick() {
  try { H?.Haptics.selectionChanged(); } catch { /* web */ }
}

/* —— transition helper ——
   requestAnimationFrame DOES NOT FIRE when the page isn't compositing (a
   hidden preview pane, a backgrounded tab). Gating class flips on it strands
   screens off-stage forever. Forced reflow + a short timeout starts the same
   CSS transition and works either way. */
export function nextTick(el, fn) {
  void el.offsetWidth;
  setTimeout(fn, 20);
}
