/**
 * Pointer handling: orbit, zoom, and picking.
 *
 * Picking drives three things at once, the way the reference does: the part
 * reddens, a floating card names it, and its legend number lights up.
 *
 * HOW THAT IS REACHED DEPENDS ON WHAT IS POINTING.
 *
 * A mouse hovers: it is over something at every instant whether or not a button
 * is down, so the pick is re-run every frame and follows the cursor. A finger
 * does not hover — between taps it is not on the glass at all — so a per-frame
 * pick would have nothing to read and the card would never appear. There the
 * pick happens on a tap and the result STAYS until the reader taps elsewhere.
 *
 * Both end up calling the same `onHover(id, prev)`, so everything downstream is
 * written once. The only thing tracked here is which kind of pointer last spoke,
 * because a tablet with a trackpad attached is both and can change mid-session.
 *
 * Zoom likewise: a wheel for a mouse, two fingers for a touchscreen. The canvas
 * carries `touch-action: none` (see the stylesheet) or the browser would claim
 * the second finger for a page zoom and cancel the gesture out from under us.
 */

import * as THREE from 'three';

/**
 * How far a press may wander and still count as a tap, by pointer kind.
 *
 * `moved` is a PATH LENGTH, not a displacement — every move event adds its own
 * |dx| + |dy| — so a press that wanders off and comes back fails this on the
 * distance it covered. That is worth knowing because it removes the need for a
 * duration limit as well: there was one here, and all it did was discard a slow
 * deliberate tap, which on a touchscreen is a page that ignores you. A press
 * that stays put is a tap however long it is held; nothing on this sheet does
 * anything else with a long press.
 */
const SLOP_FINE = 4;
const SLOP_COARSE = 10;

export function createInteraction(canvas, camera, viewCtl, pickables, handlers = {}) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /** Every pointer currently down, by id. Two of them is a pinch. */
  const down = new Map();

  let dragging = false;
  let lastX = 0, lastY = 0;
  let moved = 0;
  let hovered = null;
  let pointerInside = false;
  /** 'mouse' hovers, 'touch' and 'pen' tap. Whichever spoke last wins. */
  let lastType = 'mouse';
  const pointer = { x: 0, y: 0 };

  /** Pinch state: the finger separation and midpoint on the previous move. */
  let pinchDist = 0;
  let pinchX = 0, pinchY = 0;

  const isFine = () => lastType === 'mouse';

  const setNdc = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  };

  /** The part under a point right now, or null. */
  function pickAt(clientX, clientY) {
    setNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    const hit = hits.find((h) => h.object.visible && h.object.parent?.visible);
    return hit?.object.userData.partId ?? null;
  }

  function setHovered(id) {
    if (id === hovered) return;
    const prev = hovered;
    hovered = id;
    handlers.onHover?.(id, prev);
  }

  /** Recompute the pinch baseline. Called whenever the finger count changes. */
  function seedPinch() {
    const [a, b] = [...down.values()];
    if (!a || !b) { pinchDist = 0; return; }
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchX = (a.x + b.x) / 2;
    pinchY = (a.y + b.y) / 2;
  }

  const onDown = (e) => {
    lastType = e.pointerType || 'mouse';
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointerInside = true;
    // Throws `InvalidStateError` for a pointer that is no longer active, which
    // a cancelled-then-replayed gesture can produce. Losing capture costs the
    // drag its events outside the canvas; letting it throw costs the whole
    // handler, and with it the gesture.
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }

    if (down.size === 1) {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
      // A finger has no hover history, so the pick it will need on release has
      // to be aimed now, while it is still on the glass.
      setNdc(e.clientX, e.clientY);
    } else {
      // A second finger ends the orbit and starts a pinch. Not both at once:
      // spreading two fingers always moves them apart AND sideways, and
      // orbiting on that reads as the model squirming.
      dragging = false;
      seedPinch();
    }
  };

  const onMove = (e) => {
    lastType = e.pointerType || lastType;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointerInside = true;
    if (down.has(e.pointerId)) down.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (down.size >= 2) {
      const [a, b] = [...down.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinchDist > 0 && dist > 0) {
        viewCtl.zoomBy(dist / pinchDist);
        // The midpoint drifting is the reader carrying the model around while
        // they scale it, and it is the only way to orbit two-handed.
        viewCtl.nudge((mx - pinchX) * 0.32, (my - pinchY) * 0.26);
      }
      pinchDist = dist;
      pinchX = mx;
      pinchY = my;
      handlers.onActivity?.();
      return;
    }

    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      viewCtl.nudge(dx * 0.32, dy * 0.26);
      handlers.onActivity?.();
      return;
    }

    setNdc(e.clientX, e.clientY);
  };

  const onUp = (e) => {
    const wasSingle = down.size === 1;
    down.delete(e.pointerId);
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* already gone */ }

    const slop = isFine() ? SLOP_FINE : SLOP_COARSE;
    const tapped = wasSingle && dragging && moved < slop;

    if (tapped) {
      const id = pickAt(e.clientX, e.clientY);
      // On a touchscreen the tap IS the hover: it sets what the card and the
      // legend show, and tapping bare paper clears it again.
      if (!isFine()) setHovered(id);
      if (id) handlers.onSelect?.(id);
    }

    if (down.size >= 2) {
      seedPinch();
    } else if (down.size === 1) {
      // Lifting one of two fingers hands control back to the other. Re-seat the
      // orbit anchor on it or the model jumps by the distance between them.
      const [only] = [...down.values()];
      lastX = only.x;
      lastY = only.y;
      moved = slop;            // this is the tail of a gesture, not a new tap
      dragging = true;
      pinchDist = 0;
    } else {
      dragging = false;
      pinchDist = 0;
    }
    canvas.style.cursor = down.size ? 'grabbing' : 'grab';
  };

  const onCancel = (e) => {
    down.delete(e.pointerId);
    dragging = down.size === 1;
    pinchDist = 0;
    if (down.size >= 2) seedPinch();
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* already gone */ }
    canvas.style.cursor = down.size ? 'grabbing' : 'grab';
  };

  const onLeave = () => {
    pointerInside = false;
    // Only a mouse leaving means "nothing is under the pointer any more". A
    // finger lifting fires this too, and clearing on it would wipe the card the
    // tap just opened, before it had been read.
    if (isFine() && hovered) setHovered(null);
  };

  const onWheel = (e) => {
    e.preventDefault();
    lastType = 'mouse';
    viewCtl.zoomBy(e.deltaY > 0 ? 0.92 : 1.087);
    handlers.onActivity?.();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.cursor = 'grab';

  return {
    pointer,
    get hovered() { return hovered; },
    /** True while a gesture is in progress — the sheet uses it to step aside. */
    get active() { return down.size > 0; },

    /** Run once per frame, after the camera has been updated. */
    update() {
      // A tap-driven selection is not re-derived every frame; it stands until
      // the reader replaces it.
      if (!isFine() || dragging || down.size || !pointerInside) return;
      setHovered(pickAt(pointer.x, pointer.y));
    },

    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
