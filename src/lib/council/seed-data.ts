import type { Column, Sticky } from "./types.ts";

/**
 * Placeholder wall for QA. No facilitator names, no exec names.
 * A few exact duplicates are included so stacking can be checked.
 */
export function seedStickies(count: number, now: number): Sticky[] {
  const phrases: { column: Column; text: string }[] = [
    { column: "pm", text: "Ships prototypes in Cursor, not decks" },
    { column: "pm", text: "Ships prototypes in Cursor, not decks" },
    { column: "pm", text: "Writes evals for AI features" },
    { column: "pm", text: "Reads the data without an analyst" },
    { column: "pm", text: "Kills own ideas fast" },
    { column: "pm", text: "Kills own ideas fast" },
    { column: "pm", text: "Talks to a customer every week" },
    { column: "pm", text: "Taste: knows good when they see it" },
    { column: "designer", text: "Publishes straight to production" },
    { column: "designer", text: "Publishes straight to production" },
    { column: "designer", text: "Prototypes in code, not Figma" },
    { column: "designer", text: "Writes the copy too" },
    { column: "designer", text: "Systems thinking across surfaces" },
    { column: "designer", text: "Motion and interaction craft" },
    { column: "channel", text: "Hackathon judges and finalists" },
    { column: "channel", text: "Indie app makers shipping on X" },
    { column: "channel", text: "Ex-founders after a shutdown" },
    { column: "channel", text: "Bootcamp demo days" },
    { column: "testing", text: "Owner: growth PM. Weekly. Statsig. AI drafts hypotheses." },
    { column: "harvest", text: "our 30-day test plan template" },
  ];
  const extras: { column: Column; text: string }[] = [];
  const filler: { column: Column; stem: string }[] = [
    { column: "pm", stem: "PM signal" },
    { column: "designer", stem: "Design signal" },
    { column: "channel", stem: "Hunt signal" },
  ];
  let n = 1;
  while (phrases.length + extras.length < count) {
    const slot = filler[(n - 1) % filler.length];
    extras.push({ column: slot.column, text: `${slot.stem} ${String(n).padStart(2, "0")}` });
    n += 1;
  }
  const chosen = [...phrases, ...extras].slice(0, Math.max(0, count));
  return chosen.map((item, index) => {
    const createdAt = new Date(now + index * 1000).toISOString();
    const testing = item.column === "testing";
    return {
      id: `seed${String(index + 1).padStart(4, "0")}sticky`,
      clientId: `seed-client-${String(index + 1).padStart(4, "0")}`,
      participantId: "seeddevice01",
      column: item.column,
      text: item.text,
      author: "",
      showName: false,
      late: false,
      hidden: false,
      stackOf: null,
      label: "",
      noAuto: false,
      createdAt,
      updatedAt: createdAt,
      owner: testing ? "growth PM" : "",
      cadence: testing ? "weekly" : "",
      tools: testing ? "Statsig" : "",
      ai: testing ? "drafts hypotheses" : "",
      today: testing ? { x: 0.2, y: 0.25 } : null,
      year: testing ? { x: 0.72, y: 0.7 } : null,
    };
  });
}
