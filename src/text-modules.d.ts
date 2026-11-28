// Text files imported with { type: "text" } (bundled into the binary).
declare module "*.md" {
  const text: string;
  export default text;
}
// Readability's sources, injected into pages by reader mode (src/reader.ts).
declare module "@mozilla/readability/Readability.js" {
  const text: string;
  export default text;
}
declare module "@mozilla/readability/Readability-readerable.js" {
  const text: string;
  export default text;
}
