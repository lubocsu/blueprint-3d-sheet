/**
 * Pointer handling: orbit, zoom, and hover picking.
 *
 * Picking drives three things at once, the way the reference does: the part
 * reddens, a floating card names it, and its legend number lights up.
 */

import * as THREE from 'three';

export function createInteraction(canvas, camera, viewCtl, pickables, handlers = {}) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let dragging = false;
  let lastX = 0, lastY = 0;
  let moved = 0;
  let hovered = null;
  let pointerInside = false;
  const pointer = { x: 0, y: 0 };

  const onDown = (e) => {
    dragging = true;
    moved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointerInside = true;

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

    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  };

  const onUp = (e) => {
    if (dragging && moved < 4 && hovered) handlers.onSelect?.(hovered);
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    canvas.style.cursor = 'grab';
  };

  const onLeave = () => {
    pointerInside = false;
    if (hovered) { handlers.onHover?.(null, hovered); hovered = null; }
  };

  const onWheel = (e) => {
    e.preventDefault();
    viewCtl.zoomBy(e.deltaY > 0 ? 0.92 : 1.087);
    handlers.onActivity?.();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.cursor = 'grab';

  return {
    pointer,
    get hovered() { return hovered; },

    /** Run once per frame, after the camera has been updated. */
    update() {
      if (dragging || !pointerInside) return;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickables, false);
      const hit = hits.find((h) => h.object.visible && h.object.parent?.visible);
      const id = hit?.object.userData.partId ?? null;
      if (id !== hovered) {
        const prev = hovered;
        hovered = id;
        handlers.onHover?.(id, prev, hit);
      }
    },

    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
