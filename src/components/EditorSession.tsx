"use client";
// Remembers the previous form values so Undo can restore the last unsaved edit on this page.
import { useEffect } from "react";

const snapshot = (form: HTMLFormElement): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const element of form.elements) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) continue;
    if (!element.name || element.type === "button" || element.type === "submit") continue;
    if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked) continue;
    values[element.name] = element.value;
  }
  return values;
};

const restore = (form: HTMLFormElement, values: Record<string, string>): void => {
  for (const [name, value] of Object.entries(values)) {
    const fields = form.elements.namedItem(name);
    if (fields instanceof RadioNodeList) {
      for (const field of fields) { if (field instanceof HTMLInputElement) field.checked = field.value === value; }
    } else if (fields instanceof HTMLInputElement || fields instanceof HTMLSelectElement) fields.value = value;
  }
};

export function EditorSession({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    const undo = document.getElementById("editor-undo");
    if (!form || !undo) return;
    let previous = snapshot(form);
    let current = previous;
    let gestureStart: Record<string, string> | null = null;
    const onInput = () => { if (gestureStart) return; previous = current; current = snapshot(form); };
    const onGestureStart = () => { if (!gestureStart) gestureStart = snapshot(form); };
    const onGestureEnd = () => {
      if (!gestureStart) return;
      const after = snapshot(form);
      if (JSON.stringify(gestureStart) !== JSON.stringify(after)) { previous = gestureStart; current = after; }
      gestureStart = null;
    };
    const onClick = (event: Event) => {
      event.preventDefault();
      const target = previous;
      previous = current;
      current = target;
      restore(form, target);
      // Notify the preview without recording the restore as a new user edit.
      form.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const onSubmit = (event: SubmitEvent) => {
      const submitter = event.submitter;
      if (!(submitter instanceof HTMLButtonElement) || !submitter.formAction.endsWith("/api/forms/editor-save")) return;
      submitter.disabled = true;
      submitter.textContent = "Saving template…";
    };
    form.addEventListener("input", onInput);
    form.addEventListener("clipforge:gesturestart", onGestureStart);
    form.addEventListener("clipforge:gestureend", onGestureEnd);
    form.addEventListener("submit", onSubmit);
    undo.addEventListener("click", onClick);
    return () => { form.removeEventListener("input", onInput); form.removeEventListener("clipforge:gesturestart", onGestureStart); form.removeEventListener("clipforge:gestureend", onGestureEnd); form.removeEventListener("submit", onSubmit); undo.removeEventListener("click", onClick); };
  }, [formId]);
  return <button type="button" id="editor-undo">Undo</button>;
}
