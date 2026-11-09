/** Shared camera bounds and math for editor controls and preview gesture simulations. */
export const EDITOR_ZOOM_MIN = 1;
export const EDITOR_ZOOM_MAX = 3;
export const EDITOR_ZOOM_STEP = 0.05;
export const EDITOR_OFFSET_MIN = -1;
export const EDITOR_OFFSET_MAX = 1;

export interface EditorCamera { zoom: number; offsetX: number; offsetY: number; }
export const clampEditorZoom = (zoom: number): number => Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, Number.isFinite(zoom) ? zoom : EDITOR_ZOOM_MIN));
export const clampEditorOffset = (offset: number): number => Math.min(EDITOR_OFFSET_MAX, Math.max(EDITOR_OFFSET_MIN, Number.isFinite(offset) ? offset : 0));
export const formatEditorZoomPercent = (zoom: number): string => `${Math.round(clampEditorZoom(zoom) * 100)}%`;
export const resetEditorCamera = (): EditorCamera => ({ zoom: EDITOR_ZOOM_MIN, offsetX: 0, offsetY: 0 });
export const stepEditorZoom = (zoom: number, direction: -1 | 1): number => clampEditorZoom(Math.round((clampEditorZoom(zoom) + direction * EDITOR_ZOOM_STEP) * 100) / 100);
export const pinchEditorZoom = (startZoom: number, startDistance: number, currentDistance: number): number =>
  startDistance > 0 && Number.isFinite(currentDistance) ? clampEditorZoom(startZoom * currentDistance / startDistance) : clampEditorZoom(startZoom);
/** deltaY<0 zooms in, deltaY>0 zooms out. Exponential scaling feels consistent across wheel magnitudes. */
export const wheelEditorZoom = (zoom: number, deltaY: number): number => clampEditorZoom(zoom * Math.exp(-deltaY * 0.002));
export function panEditorCamera(camera: EditorCamera, deltaX: number, deltaY: number, width: number, height: number): Pick<EditorCamera, "offsetX" | "offsetY"> {
  if (!(width > 0 && height > 0)) return { offsetX: clampEditorOffset(camera.offsetX), offsetY: clampEditorOffset(camera.offsetY) };
  return {
    offsetX: clampEditorOffset(camera.offsetX + 2 * deltaX / width),
    offsetY: clampEditorOffset(camera.offsetY + 2 * deltaY / height),
  };
}
