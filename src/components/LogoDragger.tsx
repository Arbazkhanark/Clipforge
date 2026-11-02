"use client";
// OPTIONAL ENHANCEMENT, UNVERIFIED: lets the user drag the logo rectangle in the preview sketch with a mouse or finger.
// It only writes the new position into the form's "logoX" and "logoY" fields; the user then presses "Update preview".
// It has NEVER run in a browser (none is available here) - the sliders in the form do the same job without JavaScript.
import { useEffect } from "react";

export function LogoDragger({ svgId, formId }: { svgId: string; formId: string }) {
  useEffect(() => {
    const svg = document.getElementById(svgId) as unknown as SVGSVGElement | null; // getElementById returns HTMLElement; an <svg> needs the SVG type for viewBox
    const form = document.getElementById(formId) as HTMLFormElement | null;
    const handle = svg?.querySelector("[data-logo-handle]") as SVGGraphicsElement | null;
    const xField = form?.elements.namedItem("logoX") as HTMLInputElement | null;
    const yField = form?.elements.namedItem("logoY") as HTMLInputElement | null;
    if (!svg || !handle || !xField || !yField) return;
    let dragging = false;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const move = (event: PointerEvent) => {
      if (!dragging) return;
      const box = svg.getBoundingClientRect();
      const x = clamp((event.clientX - box.left) / box.width), y = clamp((event.clientY - box.top) / box.height);
      xField.value = x.toFixed(3); yField.value = y.toFixed(3);
      const canvas = svg.viewBox.baseVal;
      handle.setAttribute("transform", `translate(${(x - Number(handle.dataset["x"])) * canvas.width} ${(y - Number(handle.dataset["y"])) * canvas.height})`);
    };
    const down = (event: PointerEvent) => { dragging = true; handle.setPointerCapture(event.pointerId); };
    const up = () => { dragging = false; };
    handle.addEventListener("pointerdown", down); handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
    return () => { handle.removeEventListener("pointerdown", down); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
  }, [svgId, formId]);
  return null;
}
