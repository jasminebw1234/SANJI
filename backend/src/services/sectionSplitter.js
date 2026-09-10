// Splits raw extracted text into paragraph-sized sections. This is the unit
// that later phases will attach mood tags to (stage 4) and generate audio
// for (stage 5) — keeping paragraphs as the atomic unit now means Phase 2/3
// slot in without changing how Phase 1's data is shaped.

export function splitIntoSections(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  return paragraphs.map((text, index) => ({
    order_index: index,
    text
  }));
}
