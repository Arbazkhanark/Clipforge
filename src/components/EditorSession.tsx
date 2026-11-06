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
    const onInput = () => { previous = current; current = snapshot(form); };
    const onClick = (event: Event) => { event.preventDefault(); restore(form, previous); const restored = previous; previous = current; current = restored; };
    form.addEventListener("input", onInput);
    undo.addEventListener("click", onClick);
    return () => { form.removeEventListener("input", onInput); undo.removeEventListener("click", onClick); };
  }, [formId]);
  return <button type="button" id="editor-undo">Undo</button>;
}
