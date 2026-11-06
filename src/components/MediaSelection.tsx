"use client";
// Select all / clear apply only to the video checkboxes in this library form.
import { useEffect } from "react";

export function MediaSelection({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const boxes = () => [...form.querySelectorAll('input[name="media"]')] as HTMLInputElement[];
    const update = () => { const node = form.querySelector("[data-selected-count]"); if (node) node.textContent = String(boxes().filter((box) => box.checked).length); };
    const onClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset["select"] === "all") boxes().forEach((box) => { box.checked = true; });
      if (target.dataset["select"] === "clear") boxes().forEach((box) => { box.checked = false; });
      update();
    };
    form.addEventListener("change", update);
    form.addEventListener("click", onClick);
    update();
    return () => { form.removeEventListener("change", update); form.removeEventListener("click", onClick); };
  }, [formId]);
  return (
    <div className="library-actions">
      <button type="button" data-select="all">Select all on this page</button>
      <button type="button" data-select="clear">Clear selection</button>
      <p><strong data-selected-count>0</strong> selected on this page</p>
      <button type="submit">Bulk edit</button>
      <p className="muted">Select all applies only to the videos on this page, not to every filtered result.</p>
    </div>
  );
}
