export const meta = {
  name: "review-files",
  description: "Review files for bugs, then adversarially verify each finding.",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          issue: { type: "string" },
          severity: { type: "string" },
        },
        required: ["file", "issue"],
      },
    },
  },
  required: ["findings"],
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    real: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["real"],
};

const files = Array.isArray(args && args.files) ? args.files : ["src/index.ts"];

phase("Review");
const reviewed = await pipeline(
  files,
  (_prev, file) =>
    agent(`Review the file ${file} for correctness bugs. List concrete findings.`, {
      schema: FINDINGS_SCHEMA,
      label: `review:${file}`,
      phase: "Review",
    }),
  (review, file) =>
    parallel(
      ((review && review.findings) || []).map((f) => () =>
        agent(`Is this a real bug? "${f.issue}" in ${f.file}. Default to real=false if unsure.`, {
          schema: VERDICT_SCHEMA,
          label: `verify:${file}`,
          phase: "Verify",
        }).then((verdict) => ({ ...f, verdict })),
      ),
    ),
);

const confirmed = reviewed
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict && f.verdict.real);

log(`confirmed ${confirmed.length} findings`);
return { confirmed };
