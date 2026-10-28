// Test-only: lets Node import files that `import "./globals.css"` by treating CSS as an empty module.
export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  return nextLoad(url, context);
}
