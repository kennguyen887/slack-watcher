import { handleCodeRequest } from "./code-request.js";
import { handlePrReview } from "./pr-review.js";
import { handleNeedsClarification } from "./clarification.js";

// Classification kind → handler. Kinds with no entry are logged but not acted on:
// "ignore", and — deliberately — "question": the watcher only acts on code requests
// and PR reviews; questions are left for me to answer myself in Slack.
export const HANDLERS = {
  code_request: handleCodeRequest,
  pr_review: handlePrReview,
  needs_clarification: handleNeedsClarification,
};
