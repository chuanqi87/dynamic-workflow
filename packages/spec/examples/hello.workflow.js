export const meta = {
  name: "hello",
  description: "A tiny portable workflow: greet, then write blurbs in parallel.",
  phases: [{ title: "Greet" }, { title: "Blurbs" }],
};

phase("Greet");
const greeting = await agent("Reply with a one-sentence friendly greeting.");
log("got greeting");

phase("Blurbs");
const topics = ["weather", "news", "sports"];
const blurbs = await parallel(
  topics.map((t) => () => agent(`Write one upbeat sentence about ${t}.`)),
);

return { greeting, blurbs: blurbs.filter(Boolean) };
